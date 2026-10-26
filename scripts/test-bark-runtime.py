#!/usr/bin/env python3
"""Opt-in macOS integration smoke test using synthetic speech and local models."""
import argparse
import json
from pathlib import Path
import select
import subprocess
import tempfile
import time
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    args = parser.parse_args()
    fixtures = [
        ("short", "The blue notebook is on my desk.", "blue notebook"),
        ("fillers", "Um, I mean, the meeting starts tomorrow. Uh, please bring the green folder.", "green folder"),
        ("long", "We are planning a trip to the mountains next summer. We will take a train to the village and walk to the lake. Everyone should bring warm clothes and a packed lunch. After lunch we will visit the museum and buy some postcards. At the end of the day, remember to collect the purple umbrella.", "purple umbrella"),
        ("independent", "The yellow bicycle needs a new wheel.", "yellow bicycle"),
    ]
    with tempfile.TemporaryDirectory(prefix="echo-bark-smoke-") as folder:
        root = Path(folder)
        for name, text, _ in fixtures:
            subprocess.run(["/usr/bin/say", "-r", "150", "-o", str(root / f"{name}.aiff"), text], check=True)
            subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(root / f"{name}.aiff"), str(root / f"{name}.wav")], check=True)
        with wave.open(str(root / "long.wav")) as audio:
            assert audio.getnframes() / audio.getframerate() > 15, "Fixture must cross a model window"
        with wave.open(str(root / "silence.wav"), "wb") as audio:
            audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\0\0" * 32000)
        helper = subprocess.Popen([str(args.helper.resolve())], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            requests = [(name, expected) for name, _, expected in fixtures] + [("silence", None)]
            for index, (name, expected) in enumerate(requests):
                request = {"id": index + 1, "modelDirectory": str(args.models.resolve()), "audioPath": str(root / f"{name}.wav")}
                helper.stdin.write((json.dumps(request) + "\n").encode())
                helper.stdin.flush()
                deadline = time.monotonic() + 300
                while True:
                    ready, _, _ = select.select([helper.stdout], [], [], max(0, deadline - time.monotonic()))
                    assert ready, "Helper timed out"
                    line = helper.stdout.readline()
                    assert line, f"Helper exited: {helper.poll()}"
                    response = json.loads(line)
                    assert response["id"] == request["id"]
                    if response["kind"] == "preparing":
                        print("Preparing Core ML model", flush=True)
                        continue
                    assert response["kind"] == "result", response
                    if expected:
                        assert expected in response["text"].lower(), (name, response)
                    assert "<unk>" not in response["text"]
                    assert response["modelCacheHit"] == (index > 0), response
                    if name == "independent":
                        assert "umbrella" not in response["text"].lower(), response
                    if name == "silence":
                        assert not response["text"].strip(), response
                    print(json.dumps({"fixture": name, "cache_hit": response["modelCacheHit"], "load_ms": response["modelLoadMs"], "inference_ms": response["inferenceMs"]}), flush=True)
                    break
            # Missing audio produces a bounded error, then the next request can reload.
            request["id"] += 1
            request["audioPath"] = str(root / "missing.wav")
            helper.stdin.write((json.dumps(request) + "\n").encode())
            helper.stdin.flush()
            assert select.select([helper.stdout], [], [], 30)[0], "Missing-file error timed out"
            failure = json.loads(helper.stdout.readline())
            assert failure["kind"] == "error" and failure["code"] == "bark_transcription_failed", failure
            print("Missing-audio error: passed", flush=True)
        finally:
            helper.stdin.close()
            try:
                helper.wait(timeout=10)
            except subprocess.TimeoutExpired:
                helper.kill()
                helper.wait()
                raise


if __name__ == "__main__":
    main()
