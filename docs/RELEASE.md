# Echo Release Workflow

Echo is a Pettal Technology freemium product. Treat release builds as customer-facing artifacts only after signing, notarization, and clean-machine QA pass.

## macOS Signed And Notarized Builds

The `Release` GitHub Actions workflow can build macOS `.app` and `.dmg` artifacts from a manual dispatch.

Required GitHub Actions secrets:

- `APPLE_CERTIFICATE`: base64-encoded `.p12` Developer ID Application certificate.
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting the `.p12`.
- `APPLE_ID`: Apple ID email for notarization.
- `APPLE_PASSWORD`: app-specific password for the Apple ID.
- `APPLE_TEAM_ID`: Pettal Technology Apple Developer Team ID.
- `APPLE_SIGNING_IDENTITY`: signing identity shown by `security find-identity -v -p codesigning`.

Recommended local identity check:

```bash
security find-identity -v -p codesigning
```

Recommended workflow input:

- `platform`: `macos`
- `draft_release`: `true`

The workflow runs the frontend build, Rust check, then Tauri bundling for `app,dmg` with the universal Apple target. Keep the release as a draft until the downloaded `.dmg` passes clean-machine QA.

## macOS QA Gate

Before publishing a macOS release, verify on a clean macOS user account:

- First launch opens setup with clear next steps.
- Microphone permission can be granted, denied, and recovered.
- Accessibility permission can be granted, denied, and recovered.
- Global shortcut starts and stops recording.
- Paste works in Notes, Safari or Chrome, Slack, Mail, Messages, VS Code, and an unfocused text field.
- Clipboard fallback preserves the transcript when paste automation is unavailable.
- Groq mode transcribes and optionally cleans up text.
- Local mode downloads a verified model and returns raw local transcripts.
- History save, disabled-history behavior, delete, copy, and guarded clear-all work.
- Tray/menu commands open, start/stop, settings, and quit correctly.

## Windows Signing And MSI Status

Windows release signing is intentionally a placeholder until real Windows QA is available. Do not publish Windows installers from macOS-only validation.

Before enabling Windows release builds, complete and document:

- Windows shortcut press/release behavior.
- Focus restore into the previous target app.
- Clipboard write and paste simulation.
- Settings and history flows.
- Local model download and local transcription.
- Installer launch on a clean Windows machine.
- Code-signing certificate choice and storage.
- Timestamp URL and certificate thumbprint.
- MSI or NSIS target decision.

Expected future Windows signing secrets:

- `WINDOWS_CERTIFICATE`: base64-encoded signing certificate.
- `WINDOWS_CERTIFICATE_PASSWORD`: certificate export password.

Tauri supports Windows signing through bundle Windows signing configuration or a custom signing command. Add those settings only after the certificate path and Windows QA machine are available.
