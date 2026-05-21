# Echo Production Tasks

## P0: Production Blockers

- [x] Add `PRD.md` and `TASKS.md`.
- [x] Add CI checks for TypeScript build and Rust `cargo check`.
- [x] Add setup/status UI for provider, model, mic, shortcut, and paste readiness.
- [x] Move Groq API key save/load behind OS secure storage while keeping config backwards compatible.
- [x] Add shortcut validation, registration error UI, and retry guidance.
- [x] Add macOS permission help for Microphone and Accessibility.
- [ ] Harden paste/focus behavior on macOS across Notes, Safari/Chrome, Slack, Mail, Messages, VS Code, and text fields in unfocused apps.
- [ ] Verify and fix Windows core loop: shortcut press/release, focus restore, clipboard write, paste simulation, settings, history, installer build.
- [ ] Add fully structured error codes for network/API failure, missing local model, empty speech, mic unavailable, paste denied, and model download failure.

## P1: Product Completeness

- [ ] Add local model integrity checks, partial download cleanup, retry, and clearer disk-size messaging.
- [ ] Add history privacy controls: disable history, retention count, clear confirmation.
- [ ] Add transcription cleanup behavior documentation and preview copy for local mode.
- [ ] Add proper app metadata: author, copyright, bundle identifiers, icons, README production setup, license notes.
- [ ] Add macOS signing/notarization workflow and Windows signing/MSI release workflow.
- [ ] Add crash/log diagnostics suitable for support without exposing transcript/API key content.

## P2: Polish And Release Quality

- [x] Refine desktop UI density and accessibility: focus states, keyboard navigation, reduced motion, contrast, text overflow, small-window behavior.
- [x] Revamp frontend with custom light/dark Echo design system: persistent desktop sidebar, quiet native surfaces, compact settings forms, redesigned HUD, and reduced-motion-aware transitions.
- [x] Remove MUI/Emotion and replace with lightweight custom components plus lucide icons.
- [ ] Add bundle-size/code-splitting follow-up if startup performance regresses.
- [ ] Improve tray/menu wording and lifecycle: open, start/stop, settings, quit.
- [ ] Add optional launch-at-login setting.
- [ ] Add sound behavior parity or explicit platform differences for Windows.
- [ ] Add automated UI smoke tests for settings/history where practical.
- [ ] Add manual QA checklist for macOS and Windows release candidates.

## Manual QA Matrix

- macOS first run: Groq setup, local setup, mic denied/regranted, Accessibility denied/regranted, shortcut conflict, paste fallback, hidden window, tray/menu bar, dock indicator.
- Visual (custom Echo UI): light/dark themes, persistent desktop sidebar, quiet native surfaces, compact HUD, grouped history rows, compact settings controls, reduced-motion respected.
- macOS target apps: Notes, Safari, Chrome, Slack, Mail, Messages, VS Code, and browser text fields.
- Windows first run: shortcut, recording, paste/copy fallback, history, settings, local model download/transcription, and installer launch.
- Release checks: build production bundles on macOS and Windows and test on clean machines/accounts.
