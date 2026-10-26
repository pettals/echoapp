# Echo meeting notes runtime

`echo-notes` is a private JSON-lines stdin/stdout helper built from a pinned
llama.cpp revision. It uses Qwen3.5-4B Q4_K_M with a 12,288-token context,
bounded 3,072-token note output, JSON grammar, no tools, and thinking disabled.
Every request clears decoder/recurrent state; weights stay warm within a
hierarchical note-generation job. Model downloads and provider HTTP calls are
handled in Rust, never by this helper. There is no listening network socket.

Run `node scripts/build-meeting-helpers.mjs --release` from the repository root.
On macOS add `--universal` for both architectures. Windows builds use CMake/MSVC
and a static C++ runtime, with CPU inference. Apple Silicon enables embedded Metal
shaders; Intel uses CPU inference. No developer runtime is needed by app users.

The request contains `id`, `modelPath`, `system`, `input`, `schema`, and
`maxTokens`. Responses are `preparing`, `result` (structured `notes`, timings,
model-cache hit), or a safe `error`. Output never contains diagnostic paths,
credentials, prompts, transcripts, or dependency exception text. The Rust caller
caps frames and request duration, handles cancellation, and kills the child on
completion or application exit.

The single model file is 2,740,937,888 bytes, SHA-256
`00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
Revision: `e87f176479d0855a907a41277aca2f8ee7a09523`.

Opt-in synthetic evaluation:

```sh
python3 scripts/test-meeting-notes.py --helper /path/to/echo-notes --model /path/to/model.gguf
ECHO_TEST_NOTES_DIRECTORY=/path/to/model-folder cargo test --locked --manifest-path src-tauri/Cargo.toml local_runtime_consolidates_all_transcript_sections -- --ignored --nocapture
```

The latter exercises the complete Rust/native consolidation path, including
references to both ends of a simulated four-hour transcript. Set up the model
folder with the exact filename from the manifest. Metal execution may require
running outside a development tool's restrictive sandbox. Keep test fixtures
synthetic; do not capture real meeting content in diagnostic output.
