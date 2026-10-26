# Echo Bark runtime

`echo-bark` is a persistent native Swift helper for Bark 3 Clean. Requires Apple Silicon and macOS 15+ at runtime; Swift 6.2+ at build time. FluidAudio is pinned to v0.17.7 / revision `503b4bd1bbf7220882de39fe8ae6716aae4132da` in `Package.resolved`, with the NeMo text-processing trait disabled to avoid linking another Rust runtime. SwiftPM may still fetch that package's binary artifact while resolving its graph; it is not linked into the helper.

The helper uses FluidAudio's released `AsrModels.loadLocal(version: .ultra)` compatibility API rather than unmerged Bark-specific APIs. Preprocessor/decoder/joint run on CPU, with the encoder on CPU/Neural Engine. The library handles resampling and sliding windows for long recordings. No leading silence is added. Each recording gets a fresh `TdtDecoderState`; only model weights are cached. `<unk>` output markers are removed, with no second cleanup model or cloud request.

## Build and verify

```sh
swift test --package-path native/bark
node scripts/build-bark-helper.mjs
# Release produces arm64, x86_64 and universal helpers:
node scripts/build-bark-helper.mjs --universal --release
```

`npm run tauri dev` and `npm run tauri build` prepare the helper automatically on macOS. Direct use of `npx tauri` must prepare the helper first. Tauri's macOS-only config includes it as `externalBin`, so nested signing covers the executable. The `FluidAudio_FluidAudio.bundle` resources and third-party notices are included in the app's Resources. Echo's main app minimum OS is unchanged; it never launches Bark on unsupported systems.

The source model is [ConwayResearch/Underdog-Bark-3.0-Clean](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Clean), with the native conversion from [FluidInference/bark-3.0-coreml](https://huggingface.co/FluidInference/bark-3.0-coreml), revision `ca21bed2ccd9c3fbcd104a6014b9a5638a764bc8`. `src-tauri/bark-manifest.json` contains all 21 required files and SHA-256 hashes; the optional GPU encoder is excluded. The 447,420,698-byte download is staged and checked before publication. Every cold helper start rechecks all hashes. Weights and audio are never bundled into the repository or transmitted for inference.

Maintainers can regenerate the manifest and cache model files using Python (development only):

```sh
python3 scripts/prepare-bark-manifest.py --cache /tmp/echo-bark-models
python3 scripts/test-bark-runtime.py \
  --helper src-tauri/binaries/echo-bark-aarch64-apple-darwin \
  --models /tmp/echo-bark-models
```

The opt-in runtime test synthesizes speech locally with `say`: short dictation, fillers, a recording over 15 seconds, an unrelated follow-up, silence, and missing audio. It checks model reuse, window completion, state isolation, and errors. It needs no API key. It does not establish microphone, hotkey, paste permissions, clean-machine compatibility, or recognition accuracy on real speakers; use the manual QA matrix for those.

## Private protocol

One JSON object per line over child-process stdin/stdout. Requests contain `id`, `modelDirectory`, and `audioPath`. Responses echo `id` and use `kind` = `preparing`, `result`, or `error`. Result fields are `text`, `modelCacheHit`, `modelLoadMs`, and `inferenceMs` (including audio decoding). Errors carry a stable `code`; dependency error messages, paths and transcripts are not logged. Stdout is reserved for the protocol, stderr is discarded by Echo. Requests are serialized and bounded to five minutes; crashes, malformed replies or timeouts discard the child so the next dictation can restart it. EOF terminates the helper; app exit explicitly kills an in-flight helper. Model switch, deletion and replacement release cached models under the inference lifecycle lock.

Keep third-party notices from `Notices/` in distributed artifacts. Model attribution is also downloaded as part of the verified model directory.
