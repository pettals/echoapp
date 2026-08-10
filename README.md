# Echo

Echo is a macOS-first desktop dictation app from Pettal Technology. Hold a global shortcut, speak naturally, and Echo transcribes your words before pasting into the app you were already using or copying to the clipboard as a safe fallback.

## Product Status

- macOS is the production priority for v1.
- Windows support remains in the codebase, but Windows release builds and installer QA are deferred until they can be tested on a Windows machine.
- Production distribution is planned as a freemium Pettal Technology product.
- Development builds are for local testing and iteration, not final customer distribution.

## Features

- Global shortcut recording with setup validation.
- Groq-hosted Whisper transcription with optional Groq cleanup.
- Local Whisper transcription with verified model downloads and offline raw transcripts.
- macOS paste automation with clipboard fallback when Accessibility or focus restore is unavailable.
- Local transcript history with bounded retention, disable-save support, delete, copy, and guarded clear-all.
- Local Notepad with autosaved notes, markdown preview, and note-specific dictation insertion.
- Dictation insights for aggregate usage stats without storing transcript text in analytics.

## Prerequisites

- Node.js 18 or newer.
- Rust stable toolchain.
- macOS: Xcode Command Line Tools.
- Optional for Groq mode: a Groq API key from the Groq console.
- Optional for local mode: enough disk space for the selected Whisper model.

## Development Setup

```bash
npm install
npm run tauri dev
```

On first launch, Echo guides setup for provider/model readiness, microphone access, shortcut validation, and paste permission guidance.

## Supabase Auth Setup

Echo uses the Supabase project `glkriavrwsissibmwxhd` with a publishable key for account authentication. Sessions are stored through the OS credential store in Tauri builds and are not written to `config.json`.

Before testing account flows, configure Supabase Auth:

- Add redirect URLs: `echo://auth/callback`, `echo://auth/reset-password`, and `https://pettals.co.uk/echo/auth/callback/`.
- Upload `public/echo/auth/callback/index.html` to `https://pettals.co.uk/echo/auth/callback/`; Google sign-in returns there first, then opens Echo with `echo://auth/callback`.
- Keep Email authentication enabled with email confirmation required.
- Enable the Google provider.
- In Google Cloud, configure OAuth consent with `openid`, email, and profile scopes.
- Add the Supabase callback URL to the Google OAuth client: `https://glkriavrwsissibmwxhd.supabase.co/auth/v1/callback`.

## Production Checks

Run these before packaging or ticking production tasks:

```bash
npm run build
cd src-tauri
cargo check --locked
```

If both frontend and Rust/Tauri code changed, run both checks. Existing `objc` macro warnings from the macOS private API path are known.

## macOS Packaging Notes

```bash
npm run tauri build -- --bundles app,dmg
```

Before customer distribution, complete signing and notarization with Pettal Technology Apple Developer credentials. The manual GitHub Actions release workflow is documented in `docs/RELEASE.md`. Also test the signed build on a clean macOS account for microphone permission, Accessibility permission, global shortcut capture, paste fallback, tray/menu lifecycle, and local model download.

Manual release QA checklists live in `docs/MANUAL_QA.md`.

## Windows Status

Windows is intentionally not considered production-ready yet. Do not treat a macOS pass as Windows verification. Before release, test shortcut press/release, focus restore, clipboard write, paste simulation, settings, history, local transcription, and installer launch on an actual Windows machine.

The release workflow includes a Windows placeholder only. Signed Windows/MSI distribution remains blocked until Windows QA hardware is available.

## Architecture

```text
src/                  # React frontend: dashboard, settings, HUD, history, notepad
src-tauri/src/        # Rust/Tauri backend
  audio.rs            # Microphone recording via cpal
  config.rs           # Settings persistence with backwards-compatible defaults
  groq.rs             # Groq API client
  input.rs            # Clipboard and paste simulation
  model_download.rs   # Local Whisper model download and integrity validation
  whisper.rs          # Local Whisper transcription
  lib.rs              # Tauri commands and plugin setup
```

## AI Modes

| Mode | Transcription | Cleanup | Notes |
| --- | --- | --- | --- |
| Groq | Groq Whisper models | Optional Groq Llama cleanup | Fast cloud path; requires a Groq API key. |
| Local | On-device Whisper small or medium | None | Offline raw transcript; no Groq cleanup is run. |

## License Notes

Echo is a Pettal Technology product planned for freemium production distribution. See `LICENSE-NOTES.md` before sharing, packaging, or distributing builds.
