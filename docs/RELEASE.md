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

The macOS build requires Swift 6.2+ and prepares a universal `echo-bark` helper before packaging. The macOS-only Tauri config embeds it as external code, alongside `FluidAudio_FluidAudio.bundle` and `BarkNotices`. Verify `codesign --verify --deep --strict Echo.app`, `codesign --verify --strict Echo.app/Contents/MacOS/echo-bark`, and `lipo -archs Echo.app/Contents/MacOS/echo-bark` (arm64 and x86_64). Do not raise the main app's minimum OS to the helper's macOS 15 requirement. Bark is enabled only on Apple Silicon/macOS 15+; its model downloads remain separate from the installer.

Meetings also bundles universal `echo-capture` and `echo-notes` helpers, plus `MeetingNotices`. Verify the signatures and both architectures of these nested executables. The capture and notes helpers target macOS 13+; confirm that the enclosing app still launches on its existing minimum OS. Models are downloaded separately from the installer and verified against pinned SHA-256 manifests.

Before either platform is released with Meetings, provision the Echo Supabase project's Ed25519 issuer secrets and check in its public verification key (`docs/MEETINGS.md`). The release workflow refuses an empty key ring. Test a verified purchase, offline restart, account mismatch, signature tampering and verified revocation. No private signing key belongs in this repository or app. Complete the Meetings section of `MANUAL_QA.md`, including the blocked-network and four-hour tests.

## macOS QA Gate

Before publishing a macOS release, verify on a clean macOS user account:

- First launch opens setup with clear next steps.
- Microphone permission can be granted, denied, and recovered.
- Accessibility permission can be granted, denied, and recovered.
- Global shortcut starts and stops recording.
- Paste works in Notes, Safari or Chrome, Slack, Mail, Messages, VS Code, and an unfocused text field.
- Clipboard fallback preserves the transcript when paste automation is unavailable.
- Groq mode transcribes and optionally cleans up text.
- Local Whisper downloads a verified model and returns raw transcripts; Bark returns locally cleaned English transcripts and passes its section of `MANUAL_QA.md`.
- History save, disabled-history behavior, delete, copy, and guarded clear-all work.
- Tray/menu commands open, start/stop, settings, and quit correctly.

## Windows installer candidate and signing

The Windows workflow builds an unsigned NSIS installer candidate with `echo-capture` and `echo-notes` for review. It does not publish that candidate as a customer release. Sign and publish only after real Windows device testing and the Meetings licence gate pass.

Before enabling Windows release builds, complete and document:

- Windows shortcut press/release behavior.
- Focus restore into the previous target app.
- Clipboard write and paste simulation.
- Settings and history flows.
- Local model download and local transcription.
- Installer launch on a clean Windows machine.
- Code-signing certificate choice and storage.
- Timestamp URL and certificate thumbprint.
- NSIS installation and uninstall on a clean account.

Expected future Windows signing secrets:

- `WINDOWS_CERTIFICATE`: base64-encoded signing certificate.
- `WINDOWS_CERTIFICATE_PASSWORD`: certificate export password.

Tauri supports Windows signing through bundle Windows signing configuration or a custom signing command. Add those settings only after the certificate path and Windows QA machine are available.
