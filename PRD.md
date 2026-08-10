# Echo Production PRD

## Product Goal

Echo lets users hold a global shortcut, speak naturally, and have clean text pasted into the previously focused app with minimal friction.

## Primary Audience

The primary audience is macOS users who frequently dictate into chat, docs, email, notes, IDEs, and browser fields. Windows users are secondary, but the core dictation loop must work reliably there too.

## Core Success Criteria

- Users can create or access an Echo account with either Google sign-in or email/password authentication.
- First-run setup welcomes users, guides microphone and Accessibility/paste permissions, and validates the default hotkey dictation loop; provider/model setup remains visible in Settings when needed.
- Dictation works end to end: capture focus, record, transcribe, optionally clean up, paste or copy as fallback, and save history.
- During shortcut dictation, the Dynamic Island HUD shows the target app icon, live Groq partial transcript text, and a compact waveform; local Whisper shows target/waveform while recording and the final transcript after release.
- macOS feels native: menu bar behavior, hidden-window mode, dock indicator, permission messaging, and a clear signing/notarization path.
- Windows supports shortcut, recording, transcription, clipboard paste/fallback, settings, history, and installer builds.
- Failures are understandable and recoverable, especially missing API key, missing local model, denied microphone access, denied paste automation, network failures, and unavailable audio devices.

## In Scope For Production v1

- Supabase-backed authentication with Google OAuth and email/password sign-up, login, logout, and session restore.
- Echo Pro lifetime unlock with Stripe-hosted Checkout, Supabase-backed online entitlement verification, billing deep-link return, and in-app restore.
- macOS-first polish and QA.
- Groq provider and local Whisper provider.
- Download and manage local small and medium Whisper models.
- Transcription history with copy, delete, and clear.
- A task-first Dictate screen with collapsed aggregate insights for all-time word count, rolling WPM, day streak, next milestone progress, and one-time in-app milestone celebrations.
- Local Notepad for autosaved notes, markdown preview, copy/delete, and note-specific dictation insertion.
- Configurable shortcut, mic device, sounds, provider, and model choices.
- Tray/menu bar app lifecycle.
- Production packaging, signing/notarization plan, and release checklist.

## Out Of Scope For v1

- Mobile builds.
- Multi-language UI.
- Team accounts/sync.
- Passwordless magic-link login, SSO/SAML, multi-factor authentication, and subscriptions.
- Full local LLM cleanup unless added after the core app is stable.

## Product Requirements

- Authentication must support Google OAuth and email/password account creation/login.
- First-run users who are not authenticated must see a clear auth choice before setup readiness, with a way to switch between Google and email/password.
- Email/password sign-up must collect email, password, and password confirmation, validate password strength, show confirmation or verification requirements, and return users to the setup flow after success.
- Login errors must be actionable: invalid credentials, existing email, weak password, network failure, OAuth cancellation, and unverified email should each leave the user with a clear next step.
- Sessions must restore on app launch and persist securely without storing credentials in plaintext config.
- Users must be able to sign out from Settings, after which local-only data remains on device unless a later sync feature explicitly changes that behavior.
- Authentication must not weaken local privacy expectations: transcript history, Notepad notes, and dictation insights remain local in v1.
- Echo Pro must be a lifetime unlock purchased through Stripe-hosted Checkout in a browser, with `echo://billing/complete` and `echo://billing/cancel` return links plus app-side checkout-session confirmation, polling, and restore entitlement flows after checkout.
- Echo Pro unlocks only two v1 features: unlimited local transcript history and the cloud provider flow where users add their own Groq API key.
- Free users must retain local dictation, local Whisper, Notepad, insights, and up to 100 local history items.
- Free users who click locked cloud or unlimited-history affordances must see a compact paywall prompt with a clear online checkout action and restore action.
- Paid entitlement must be verified through Supabase during the current online session before Pro features run; any local entitlement cache is display/diagnostic context only, not authorization.
- If Echo cannot refresh Pro entitlement while cloud mode is selected, it must notify the user and temporarily use local Whisper when a local model is ready, without overwriting the saved cloud preference.
- If Echo cannot verify Pro entitlement and no local model is downloaded, dictation must stop with a clear reconnect-or-download next step.
- Unlimited history also requires fresh online Pro verification. When verification is unavailable, new local history saves follow the free 100-item cap.
- Stripe and Supabase must store only billing/customer/entitlement metadata. Transcript text, Notepad notes, dictation insights, and Groq API keys must stay local, with Groq keys in OS secure storage.
- First run must not strand users without a clear next action; if provider/model setup is missing, onboarding must point users to Settings explicitly.
- Echo must expose an actionable setup state for mic, shortcut, provider/model, and paste permissions when a check is incomplete. Healthy Settings must not show persistent readiness UI.
- Auto-paste must gracefully fall back to copying without losing the transcript.
- Groq dictation must stream low-latency rolling partial transcripts into the Dynamic Island while preserving the final full-recording transcription as the source of truth for paste/history.
- If no external paste target is captured, the persistent HUD must show the transcript with a copy action and a short countdown before returning to idle.
- History must be bounded, user-clearable, and documented.
- Dictation insights must store only aggregate usage stats, not transcript text, and must remain independent of transcript history retention.
- Notepad notes must remain local, autosave while editing, and support dictation insertion without triggering external paste automation.
- Local mode must explain model sizes, disk use, download state, and offline behavior.
- Local mode must avoid repeated model loads during an app session, expose a conservative CPU usage control, and show safe timing diagnostics that exclude transcripts, audio content, paths, and secrets.
- Windows must not present macOS-only affordances as working features.
- The desktop UI should use the custom Echo design system: clean light/dark content themes, a persistent dark purple-pink gradient sidebar with white navigation, native system typography, graphite and cool-neutral grouped surfaces, monochrome primary actions, cohesive `46px` form controls, compact desktop density, and reduced-motion-aware transitions. Workspace styling must remain isolated from the Dynamic Island HUD.
- Home must remain task-first: dictation state and the platform-rendered shortcut are primary, duplicate navigation is omitted, insights are collapsed by default, and troubleshooting appears only when relevant.
- Settings must use compact Account, Dictation, Input, and App tabs with grouped rows and progressive disclosure. Healthy readiness stays hidden, Pro messaging is centralized in Account, and Save/Discard appears only for pending changes.
- Customer-facing UI must use the consistent vocabulary `Cloud`, `On-device`, `Groq API key`, `shortcut`, `dictation history`, and `setup`. Raw command names, internal performance phases, configuration filenames, and error codes must not appear in primary UI.

## Production Risks

- Supabase Auth redirect handling in a Tauri desktop app needs careful deep-link/callback handling, especially for Google OAuth and session restore.
- Email verification, password reset, and OAuth provider configuration can strand first-run users if callback URLs and recovery states are incomplete.
- macOS Accessibility/AppleScript paste flow needs explicit permission onboarding and real-app testing.
- Windows media ducking is currently a no-op.
- Shortcut capture needs validation and conflict feedback.
- API key storage must use OS secure storage rather than plain JSON.
- Stripe webhook correctness is required as the async entitlement grant path; duplicate, failed, or spoofed webhook/session confirmations must not incorrectly unlock users.
- Release process needs CI, signed builds, an update strategy, and a QA matrix.
