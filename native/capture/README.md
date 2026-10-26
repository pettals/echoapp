# Echo meeting audio capture

The macOS SwiftPM `echo-capture` helper targets macOS 13+, using an AVAudioEngine
microphone tap and ScreenCaptureKit system audio. No screen output is registered,
read or saved. The Windows C++ helper uses shared-mode WASAPI microphone capture
and render-endpoint loopback, without virtual audio drivers. Both use the system
default devices and the same private JSON-lines protocol.

The first request provides a private `directory` and `mode` (`online` or
`in-person`). Later commands are `pause`, `resume`, and `stop`. Events include
startup, input levels, clock, paused/resumed, chunk metadata, stopped, limit and
safe errors. EOF also stops recording. Capture and dictation share a Rust start
gate, so two Echo capture sessions cannot claim the microphone concurrently.

Audio is normalized to mono 16 kHz PCM16. Files contain at most 15 seconds with
500 ms overlap, separate microphone/computer source labels, and common-clock
timestamps excluding pauses. A timing journal is durably written before the
chunk event. Rust commits ASR segments before deleting their WAV/journal pair.
Raw ASR text remains available; the assembled transcript removes overlapping
boundary words and conservative, long exact playback-echo word runs.

Swift microphone callbacks have a bounded queue. Write/device/helper failures
stop capture and retain unprocessed files for recovery/discard. A four-hour
active-recording limit stops recording without silently discarding the transcript.

```sh
swift test --package-path native/capture -c release
node scripts/build-meeting-helpers.mjs --release
```

The synthetic four-hour test simulates both sources, verifies bounded WAV files
and journals, and deletes chunks after a simulated durable transcript commit.
Real-device permissions, acoustic playback echo, Bluetooth changes, sleep and
full-duration endurance still require the manual QA matrix before release.
