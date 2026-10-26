#!/usr/bin/env python3
"""Maintainer tool: pin and verify Bark files; Python is never shipped to users."""
import hashlib
import json
from pathlib import Path
import urllib.request
import argparse

REPO = "FluidInference/bark-3.0-coreml"
REVISION = "ca21bed2ccd9c3fbcd104a6014b9a5638a764bc8"
PREFIX = "bark-3.0-clean/"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    url = f"https://huggingface.co/api/models/{REPO}/tree/{REVISION}/bark-3.0-clean?recursive=true&limit=1000"
    with urllib.request.urlopen(url, timeout=60) as response:
        entries = json.load(response)
    files = []
    for entry in sorted(entries, key=lambda item: item["path"]):
        if entry["type"] != "file" or "/Encoder_lut3.mlmodelc/" in entry["path"]:
            continue
        relative = entry["path"].removeprefix(PREFIX)
        path = args.cache / relative
        expected = entry.get("lfs", {}).get("oid")
        if not path.exists() or path.stat().st_size != entry["size"]:
            path.parent.mkdir(parents=True, exist_ok=True)
            part = path.with_name(path.name + ".part")
            with urllib.request.urlopen(f"https://huggingface.co/{REPO}/resolve/{REVISION}/{entry['path']}", timeout=120) as response, part.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
            part.replace(path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if path.stat().st_size != entry["size"] or (expected and digest != expected):
            raise RuntimeError(f"Integrity check failed: {relative}; remove cached file and retry")
        files.append({"path": relative, "size": entry["size"], "sha256": digest})
        print(f"Verified {relative}", flush=True)
    manifest = {"repository": REPO, "revision": REVISION, "prefix": PREFIX, "files": files}
    root = Path(__file__).resolve().parent.parent
    (root / "src-tauri/bark-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Manifest: {len(files)} files, {sum(item['size'] for item in files):,} bytes")


if __name__ == "__main__":
    main()
