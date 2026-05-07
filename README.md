# WhisperClone

A cross-platform desktop voice dictation app powered by open-source AI models. Press a global shortcut, speak, and get polished text pasted into your active application.

## Features

- **Global hotkey** — start/stop recording from any app (default: `Cmd+Shift+Space` / `Ctrl+Shift+Space`)
- **Fast transcription** — powered by Groq-hosted Whisper Large v3 Turbo (open-source)
- **AI cleanup** — optional filler word removal and punctuation fixes via Llama 3.1 8B
- **Auto-paste** — transcribed text is copied to clipboard and pasted into the focused app
- **Configurable models** — choose speed vs accuracy for both transcription and cleanup
- **macOS & Windows** — native builds for both platforms

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Rust](https://rustup.rs/) (stable toolchain)
- A [Groq API key](https://console.groq.com/keys)
- macOS: Xcode Command Line Tools
- Windows: Visual Studio Build Tools with C++ workload

## Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

On first launch, you'll be prompted to enter your Groq API key in the Settings screen.

## Building

```bash
# Production build (creates .dmg on macOS, .msi on Windows)
npm run tauri build
```

## Architecture

```
src/                  # React frontend (overlay UI, settings)
src-tauri/src/        # Rust backend
  ├── audio.rs        # Microphone recording via cpal
  ├── config.rs       # Settings persistence
  ├── groq.rs         # Groq API client (Whisper + Llama)
  ├── input.rs        # Paste simulation via enigo
  ├── lib.rs          # Tauri commands and plugin setup
  └── main.rs         # Entry point
```

## AI Models Used

All models are open-source and hosted on [Groq](https://groq.com) for fast inference:

| Purpose | Model | Speed |
|---------|-------|-------|
| Transcription (fast) | `whisper-large-v3-turbo` | 216x real-time |
| Transcription (accurate) | `whisper-large-v3` | 189x real-time |
| Cleanup (fast) | `llama-3.1-8b-instant` | ~560 tok/s |
| Cleanup (quality) | `llama-3.3-70b-versatile` | ~280 tok/s |

## macOS Permissions

WhisperClone needs:
- **Microphone access** — for audio recording
- **Accessibility** — for simulating paste (Cmd+V) into other apps

The app will prompt for these on first use.

## License

MIT
