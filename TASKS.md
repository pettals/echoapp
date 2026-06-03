# Echo Production Tasks

## P0: Production Blockers

- [x] Add `PRD.md` and `TASKS.md`.
- [x] Add CI checks for TypeScript build and Rust `cargo check`.
- [x] Add Supabase Auth foundation: project env config, typed client wrapper, secure session persistence, and app launch session restore.
- [x] Configure Google OAuth for desktop auth callbacks and document required Supabase redirect URLs for development and production builds.
- [x] Add email/password auth: sign-up, login, password confirmation validation, weak-password feedback, and unverified-email recovery state.
- [x] Add logout flow in Settings and ensure signed-out users return to the auth/onboarding entry point without losing local app data.
- [x] Add setup/status UI for provider, model, mic, shortcut, and paste readiness.
- [x] Move Groq API key save/load behind OS secure storage while keeping config backwards compatible.
- [x] Harden Groq runtime integration with connection testing, typed API errors, upload preflight, and cleanup fallback.
- [x] Add shortcut validation, registration error UI, and retry guidance.
- [x] Add macOS permission help for Microphone and Accessibility.
- [x] Harden paste/focus behavior on macOS across Notes, Safari/Chrome, Slack, Mail, Messages, VS Code, and text fields in unfocused apps.
- [ ] Verify and fix Windows core loop: shortcut press/release, focus restore, clipboard write, paste simulation, settings, history, installer build.
- [x] Complete structured error codes beyond partial Groq/config coverage: missing local model, empty speech, mic unavailable, paste denied, and model download failure.

## P1: Solid Onboarding Phase

- [x] Add first-run auth gate before setup readiness with Google sign-in and email/password tabs.
- [x] Add OAuth callback/deep-link handling in Tauri so Google sign-in returns users to Echo and resumes onboarding.
- [x] Add auth loading, success, cancellation, network failure, invalid credentials, existing email, weak password, and unverified email UI states.
- [x] Add password reset entry point and recovery copy, even if full reset completion is deferred to Supabase-hosted email links.
- [x] Add a guided first-run onboarding flow that uses the existing setup readiness checks instead of sending new users directly into Settings.
- [x] Add provider selection onboarding for Groq API vs local Whisper, with clear tradeoffs for speed, privacy, internet requirement, and setup effort.
- [x] Add Groq setup step with secure API-key save, connection test, model readiness feedback, and clear failure recovery.
- [x] Add local Whisper setup step with model-size explanation, disk-space messaging, download progress, retry handling, and offline-readiness confirmation.
- [x] Add microphone setup step with device selection, permission guidance, live mic test, and a clear success/failure state.
- [x] Add global shortcut setup step with capture UI, validation, registration failure guidance, and conflict recovery.
- [x] Add macOS paste-permission onboarding for Accessibility, including System Settings deep link, trusted/untrusted status, and clipboard-copy fallback explanation.
- [x] Add Windows onboarding copy that avoids macOS-only Accessibility language while confirming clipboard/paste expectations.
- [x] Add a final "try your first dictation" step that validates the full loop: target focus, record, transcribe, paste or copy fallback, and history behavior.
- [x] Persist `onboarding_completed` after the user reaches a ready state and completes the first dictation test, or explicitly skips onboarding.
- [x] Add a lightweight way to reopen onboarding from Settings or the app menu for troubleshooting and reconfiguration.
- [x] Ensure onboarding error states always include the next action and never strand users on a generic Settings screen.
- [ ] Add auth onboarding QA coverage for new account, existing account, Google OAuth success/cancel/failure, email sign-up, email login, bad password, unverified email, logout, app relaunch session restore, and offline launch.
- [x] Add onboarding QA coverage to the manual matrix for fresh installs, returning users with existing config, denied permissions, skip path, Groq failure, local model failure, and Windows first run.

## P2: Product Completeness

- [x] Add Account section in Settings with signed-in identity, provider label, logout action, and privacy note that v1 history/notes/insights stay local.
- [x] Add auth-aware route/state model so authenticated users continue into the existing setup flow, while signed-out users cannot skip required auth accidentally.
- [ ] Add tests for auth state transitions and onboarding routing where practical.
- [x] Add local model checksum/integrity validation and clearer disk-size messaging; partial download cleanup and retry UI are partially in place.
- [x] Add history clear confirmation and verify disabled-history UX.
- [x] Add transcription cleanup behavior documentation and preview copy for local mode.
- [x] Add local Notepad MVP with autosaved notes, markdown preview, and note-specific dictation insertion.
- [x] Add Dictate insights bento dashboard with aggregate stats and milestone celebrations.
- [x] Add proper app metadata: author, copyright, license notes, README production setup, and final icon polish; bundle icons are partially updated.
- [x] Add macOS signing/notarization workflow and Windows signing/MSI release workflow.
- [x] Add crash/log diagnostics suitable for support without exposing transcript/API key content.

## P3: Polish And Release Quality

- [ ] Remove the dev-only "Skip sign in" auth bypass before production builds ship.
- [x] Refine desktop UI density and accessibility: focus states, keyboard navigation, reduced motion, contrast, text overflow, small-window behavior.
- [x] Revamp frontend with custom light/dark Echo design system: persistent desktop sidebar, dark dashboard surfaces, compact settings forms, redesigned HUD, and reduced-motion-aware transitions.
- [x] Apply macOS HIG polish pass: calmer SF Pro scale, top-leading dictation workspace, native grouped settings, durable HUD errors, and app menu commands.
- [x] Add persistent Dynamic Island HUD with hover actions, live waveform recording, and no-target copy review.
- [x] Add Groq-first live transcript Dynamic Island with target app icon, rolling partial text, and local-provider fallback.
- [x] Remove MUI/Emotion and replace with lightweight custom components plus lucide icons.
- [x] Add bundle-size/code-splitting follow-up if startup performance regresses.
- [x] Finalize tray/menu wording and lifecycle QA: open, start/stop, settings, quit.
- [x] Add optional launch-at-login setting.
- [ ] Verify/document Windows sound behavior and media-ducking difference.
- [ ] Add automated UI smoke tests for settings/history where practical.
- [ ] Add manual QA checklist for macOS and Windows release candidates.

## Manual QA Matrix

- Authentication: Google OAuth first run and returning login, OAuth cancellation, email/password sign-up, existing-email handling, invalid login, unverified email, password reset entry point, logout, session restore after app restart, offline launch with existing session, and signed-out relaunch.
- Onboarding: fresh installs, returning users with existing config, denied permissions, skip path, Groq failure, local model failure, and Windows first run.
- macOS first run: Groq setup, local setup, mic denied/regranted, Accessibility denied/regranted, shortcut conflict, paste fallback, hidden window, tray/menu bar, dock indicator.
- Visual (custom Echo UI): dark-first dashboard theme, light/system theme choices, persistent desktop sidebar, Dynamic Island HUD states, insights bento dashboard, grouped history rows, local Notepad editor, compact settings controls, reduced-motion respected.
- macOS target apps: Notes, Safari, Chrome, Slack, Mail, Messages, VS Code, and browser text fields.
- Windows first run: shortcut, recording, paste/copy fallback, history, settings, local model download/transcription, and installer launch.
- Release checks: build production bundles on macOS and Windows and test on clean machines/accounts.
