# Echo Windows Rebuild Prompt

Use this as the prompt for a colleague or coding agent building Echo for Windows from the ground up. It assumes the macOS app already defines the intended product, brand, UX, and behavior, while Windows implementation details must be validated on real Windows hardware.

## Prompt To Send

You are building **Echo**, a Windows desktop dictation app from **Pettal Technology**. Build the Windows version from the ground up, but match the existing Echo macOS product in functionality, branding, privacy posture, onboarding, and user experience.

Echo is a desktop utility that lets a user hold a global shortcut, speak naturally, transcribe the recording, optionally clean it up, and paste the resulting text into the app that was focused before dictation started. If automatic paste cannot be completed, Echo must copy the transcript to the clipboard and clearly tell the user what to do next.

## Product Definition

Echo must feel like the same app as the macOS version:

- Product name: **Echo**.
- Company: **Pettal Technology**.
- Core promise: hold a global shortcut, speak, release, and get clean text pasted where the user was working.
- Primary platform for this build: **Windows**.
- Windows must not inherit macOS-only assumptions. Test everything on actual Windows hardware.
- Keep Windows functionally complete even if some macOS polish, such as Accessibility permission prompts, does not apply.

## Recommended Stack

Prefer the same family of technologies unless there is a strong reason not to:

- Tauri 2 desktop shell.
- React + TypeScript frontend.
- Rust backend for native desktop integration.
- Vite build.
- `cpal` or equivalent for microphone recording.
- `hound` or equivalent for WAV writing/reading.
- `reqwest` or equivalent for Groq and model downloads.
- `whisper-rs` or equivalent for local Whisper.
- OS credential store through `keyring` or Windows Credential Manager.
- Tauri plugins or native equivalents for global shortcut, deep links, tray, clipboard, autostart, and single instance.

If using another Windows-native stack, preserve the behavior contract exactly.

## Brand And Visual Direction

Use the existing Echo identity:

- Dark mode is the default.
- Light and System themes must remain selectable and legible.
- Use a calm, premium, desktop-first utility style.
- Use a persistent left sidebar and one main scrollable workspace.
- Keep controls compact and professional.
- Use the Echo dolphin logo mark and Echo wordmark.
- Reuse the existing brand assets from the source project where possible:
  - `src/assets/echoNewLogo.png`.
  - `src/assets/echoNewLogoMark.png`.
  - `src/assets/echo-logo.svg`.
  - `src/assets/groq-logo.svg`.
  - `src-tauri/icons/icon.ico`.
  - `src-tauri/icons/tray-icon.png`.
- Primary accent is magenta-to-purple from the logo.
- Green is reserved for success/readiness.
- Use Lucide-style minimal line icons.
- Use restrained motion under about 180 ms, and respect reduced-motion settings.
- Avoid generic landing-page layouts. The first signed-in screen is the usable app.

Core visual surfaces:

- Fixed sidebar navigation.
- Floating main content panel.
- Dictate dashboard.
- Dynamic Island-style HUD overlay.
- Settings sections.
- History rows.
- Notepad split list/editor.
- Compact tray/menu lifecycle.

## Core User Loop

Implement this end-to-end before polishing secondary features:

1. User focuses a target app, such as Word, Chrome, Slack, Outlook, VS Code, Notepad, or a browser text field.
2. User holds the global shortcut. Default shortcut is `CommandOrControl+D`, which should render as `Control+D` on Windows.
3. Echo captures the currently focused Windows foreground window before showing its own HUD.
4. Echo starts microphone recording.
5. Echo displays the HUD with recording state, waveform level, target info where available, and live transcript when using Groq.
6. User releases the shortcut.
7. Echo stops recording and resumes any paused/ducked media behavior if implemented.
8. Echo checks whether the recording contains enough speech.
9. Echo transcribes using the selected provider:
   - Groq cloud Whisper mode.
   - Local Whisper mode.
10. If Groq cleanup is enabled, Echo cleans the final transcript with the selected cleanup model.
11. Echo writes the final transcript to the clipboard.
12. Echo restores focus to the original target window.
13. Echo simulates `Ctrl+V`.
14. If focus restore or paste simulation fails, Echo leaves the transcript on the clipboard and shows a clear fallback state.
15. Echo saves transcript history if history is enabled.
16. Echo updates aggregate dictation insights without storing transcript text in analytics.

## Authentication

Echo v1 requires account authentication before normal setup:

- Support Google OAuth.
- Support email/password sign-up and login.
- Support email verification pending state.
- Support invalid credentials, existing email, weak password, network failure, OAuth cancellation, and unverified email states with clear next steps.
- Support password reset entry point.
- Support password recovery callback and updating password if the app receives a recovery deep link.
- Restore session on app launch.
- Store auth sessions in OS secure storage, not plaintext config.
- Keep local transcript history, Notepad notes, and dictation insights local in v1. Signing in must not imply cloud sync.
- Settings must include account identity, provider label, logout, and a privacy note.

Deep links:

- Register `echo://auth/callback`.
- Register `echo://auth/reset-password`.
- Handle Google OAuth through the team’s configured web bridge if required.
- Use PKCE.
- Avoid leaking access tokens or refresh tokens into logs.

## Onboarding

First run must be a guided setup flow, not a settings dump.

Required flow:

1. Branded welcome.
2. Auth gate if not signed in.
3. Microphone and paste readiness.
4. Hotkey capture/validation.
5. Full dictation test.
6. Completion state.

Setup readiness must always expose these checks:

- Provider/model readiness.
- Microphone readiness.
- Shortcut validity.
- Paste readiness.

Provider/model readiness:

- In Groq mode, verify a Groq API key exists in secure storage and optionally test selected models.
- In local mode, verify the selected Whisper model is downloaded and passes integrity checks.

Microphone readiness:

- List available input devices.
- Let user choose a device.
- Provide a live or short microphone test.
- Open Windows microphone privacy settings using `ms-settings:privacy-microphone`.
- If no device is found or the mic is blocked, tell the user exactly what to do.

Shortcut readiness:

- Default to `CommandOrControl+D`, displayed as `Control+D`.
- Let users capture a replacement shortcut.
- Reject empty shortcuts, duplicated keys, modifier-only shortcuts, and invalid formats.
- Surface registration conflicts and retry guidance.

Paste readiness:

- The macOS app has an Accessibility permission check because macOS requires Accessibility trust for automatic paste simulation.
- Windows does not need macOS Accessibility permission.
- Show this as “Paste readiness”, not “Accessibility”.
- Confirm Echo will use clipboard write plus `Ctrl+V` simulation.
- Always preserve copy-to-clipboard fallback.
- Provide a full loop test that checks record, transcribe, paste or copy fallback, and history behavior.

Never strand users. Every failed onboarding state must include one clear next action.

## Main Navigation

Use a persistent desktop sidebar with:

- Dictate/Home.
- Notepad.
- History.
- Settings.

The Dictate view should be the main working surface. Do not add a big marketing hero. There should be no primary “Start” button requirement; dictation is driven by shortcut, tray/menu, and HUD actions.

## Dictate Dashboard

The Dictate screen must show:

- Current app state: idle, recording, processing, success, copied, or error.
- Shortcut keycaps rendered for Windows.
- Setup readiness if blocked.
- Dictation insights:
  - Total words.
  - Dictation count.
  - Rolling WPM.
  - Day streak.
  - Next milestone progress.
- Quick actions:
  - Open Notepad.
  - View History.
  - Check Setup.
  - Open Settings.
- Recent safe performance diagnostics for the last dictation, excluding transcript text, audio content, file paths, and secrets.
- Milestone celebrations for one-time word milestones: 100, 1,000, 2,000, 5,000, 7,500, 10,000, 20,000, 50,000, 100,000.

## Dynamic Island HUD

Build a compact always-on-top HUD overlay that works on Windows:

- Idle collapsed pill.
- Hover expanded state with quick actions.
- Recording state with waveform and target context.
- Processing/transcribing state.
- Success state.
- Copied fallback state.
- No-target copy review state with transcript preview, copy action, Notepad action, and countdown before returning to idle.
- Error state with concise actionable message.

Groq mode:

- Stream rolling live partial transcript text while recording.
- Treat final full-recording transcription as source of truth for paste/history.

Local mode:

- Show recording target and waveform while recording.
- Show final transcript after release.

The HUD must not steal focus from the target app during normal shortcut dictation. If Windows makes non-activating overlay behavior hard, document the chosen technique and test it against real apps.

## Transcription Providers

Support two modes.

### Groq Cloud Mode

- Requires user-provided Groq API key.
- Store Groq API key only in Windows Credential Manager or equivalent secure OS storage.
- Never store Groq keys in plaintext config.
- Migrate any legacy plaintext key into secure storage and sanitize the config.
- Validate the API key and selected models from Settings.
- Transcription models:
  - `whisper-large-v3-turbo` for fast default.
  - `whisper-large-v3` for accuracy.
- Cleanup models:
  - `llama-3.1-8b-instant` for fast default.
  - `llama-3.3-70b-versatile` for quality.
- Cleanup is optional and only applies to Groq/cloud mode.
- If cleanup fails but transcription succeeded, preserve the transcript and explain the fallback.
- Chunk large WAV uploads safely so direct upload limits do not break long recordings.

### Local Whisper Mode

- Works offline after model download.
- No Groq cleanup is run in local mode.
- Support local model sizes:
  - Small: fastest everyday model, expected size about 487.6 MB.
  - Medium: more accurate model, expected size about 1.53 GB.
- Download from the public Whisper model source first, with team-controlled signed fallback if available.
- Require sign-in for fallback/private model download endpoints if the product expects that.
- Show download progress.
- Clean up partial downloads on failure.
- Verify model size and SHA-256 integrity.
- Allow deleting downloaded models.
- Cache loaded Whisper model per session to avoid repeated reloads.
- Provide local CPU/thread control:
  - Balanced default.
  - Light, Steady, Fast, Faster, Fastest.
- Emit safe timing diagnostics: speech check, model cache hit, model load time, audio decode time, inference time, total time.

## Audio Recording

Use a reliable Windows audio capture path:

- List input devices.
- Use selected device or default input.
- Record to temporary WAV.
- Track smoothed live recording level for the HUD.
- Detect empty/no-speech recordings and return a friendly retryable error.
- Clean up temporary WAV files after success or expected errors.
- Support live audio chunks for Groq partial transcription.
- Avoid retaining audio after the dictation is processed.

No-speech error copy:

“Echo captured audio, but there was not enough speech to transcribe. Hold the shortcut while speaking, then release when done.”

## Focus Restore And Paste On Windows

This is the highest-risk Windows-specific area. Build and test it carefully.

Expected behavior:

- Before opening or expanding Echo UI, capture the target foreground window handle.
- Ignore Echo’s own window as a paste target.
- On release, restore that target window.
- Use Windows foreground-window APIs carefully:
  - `GetForegroundWindow`.
  - `GetWindowThreadProcessId`.
  - `GetCurrentThreadId`.
  - `AttachThreadInput` where needed.
  - `ShowWindow` for minimized targets.
  - `BringWindowToTop`.
  - `SetForegroundWindow`.
- After restoring focus, wait briefly, then simulate `Ctrl+V`.
- Prefer `SendInput` or a proven automation library.
- Always write clipboard first.
- If restore or paste simulation fails, return a copied fallback status.
- Fallback statuses should distinguish:
  - `pasted`.
  - `copied`.
  - `copied_no_target`.
  - `copied_accessibility` or a Windows-equivalent paste-denied status if automation fails.

Test against:

- Notepad.
- Word.
- Outlook.
- Teams or Slack.
- Chrome and Edge text fields.
- VS Code.
- An unfocused browser field.
- A minimized target app.
- A target app on another monitor if possible.

## Clipboard

- Write clipboard using a robust Windows API or PowerShell fallback.
- Preserve Unicode text, line breaks, punctuation, and markdown-like text.
- Do not read or log unrelated clipboard contents.
- Copy action in History and Notepad should use the same safe clipboard path.

## History

Local transcript history must support:

- Save enabled/disabled setting.
- Bounded retention.
- Default history limit: 100.
- Hard clamp to 100 unless product owner changes it.
- Search.
- Copy item.
- Delete item.
- Clear all with confirmation.
- Paste/copy status label.
- Timestamp.

If history is disabled:

- New dictations are not saved.
- Existing history remains until the user clears it.
- Dictation insights still update because they store aggregate metrics only.

## Dictation Insights

Store aggregate stats locally:

- Total words.
- Dictation count.
- Rolling WPM using recent valid samples.
- Daily word counts for streak.
- Achieved milestones.

Do not store transcript text in analytics.
Settings must allow clearing insights without clearing history or Notepad notes.

## Notepad

Build a local Notepad workspace:

- Local notes only.
- Note list.
- Search notes.
- Create note.
- Autosave edited note body.
- Delete note.
- Copy note body.
- Markdown preview or markdown-friendly rendering.
- Dictation insertion into the selected note.

Important behavior:

- If the Notepad window/editor is the active dictation target, insert the transcript into the note rather than pasting into an external app.
- Do not trigger external paste automation for Notepad-specific insertion.
- Provide a standalone Notepad window if the architecture supports it.

## Settings

Settings must include:

- Account section:
  - Signed-in email.
  - Provider label.
  - Logout.
  - Local privacy note.
- Setup readiness card:
  - Provider.
  - Microphone.
  - Shortcut.
  - Paste.
- Provider selection:
  - Groq Cloud.
  - Local Whisper.
- Groq controls:
  - API key input.
  - Test connection.
  - Transcription model select.
  - Cleanup model select.
  - Cleanup enabled toggle.
- Local controls:
  - Small/medium model cards.
  - Download, progress, verify, delete.
  - Thread/CPU setting.
  - Offline behavior explanation.
- Microphone controls:
  - Input device select.
  - Test microphone.
- Shortcut controls:
  - Capture shortcut.
  - Save/apply shortcut.
  - Registration error display.
- History controls:
  - Enable/disable history.
  - History limit.
  - Explain retention.
- Insights:
  - Clear insights with confirmation.
- Appearance:
  - System, Light, Dark.
- Sounds:
  - Enable sounds.
  - Indicator sound.
  - Success sound.
  - Preview sound.
- Launch at login:
  - Off by default.
  - Toggle must reflect actual OS autostart state.

## App Config

Use a backwards-compatible config schema with defaults. Do not make old configs fail if a field is missing.

Required fields:

```json
{
  "groq_api_key": "",
  "shortcut": "CommandOrControl+D",
  "transcription_model": "whisper-large-v3-turbo",
  "cleanup_model": "llama-3.1-8b-instant",
  "cleanup_enabled": true,
  "input_device": null,
  "model_provider": "api",
  "local_model_size": "small",
  "local_transcription_threads": null,
  "sounds_enabled": true,
  "indicator_sound": "tink",
  "success_sound": "glass",
  "onboarding_completed": false,
  "history_enabled": true,
  "history_limit": 100,
  "appearance_theme": "dark",
  "launch_at_login": false
}
```

Security rules:

- Persist config without secrets.
- Store Groq API key in secure OS storage.
- Store auth sessions in secure OS storage.
- Redact secrets in logs and diagnostics.

## Tray, Menu, And Lifecycle

Windows tray/menu must support:

- Open Echo.
- Start Dictation.
- Stop Dictation.
- View History.
- Settings.
- Quit Echo.

Window lifecycle:

- Closing the main window should hide the app, not kill the global shortcut.
- Quit must fully exit and remove tray controls.
- Single-instance behavior should bring the existing app forward.
- Launch at login toggle should use Windows autostart mechanisms.
- Installer target can be NSIS/MSI, but it must be tested on a clean Windows account.

## Sounds And Media

Settings include sounds:

- Tink.
- Pop.
- Glass.
- Hero.
- Purr.
- Morse.
- None.

Use packaged audio files or map to Windows system sounds. If media pause/ducking is not reliable on Windows, make it a documented no-op rather than a silent broken feature.

## Diagnostics And Errors

Use structured, actionable errors:

- `missing_api_key`.
- `missing_local_model`.
- `empty_speech`.
- `mic_unavailable`.
- `paste_denied`.
- `model_download_failed`.
- `model_integrity_failed`.
- `network_error`.
- `config_load_failed`.
- `secure_write_failed`.
- `shortcut_registration_failed`.

Support diagnostics must be safe:

- Include app version, platform, arch, provider, selected models, local model status, setup status, history item count, notepad note count, stats counts, and recent safe error codes.
- Exclude transcript text.
- Exclude Notepad note contents.
- Exclude audio.
- Exclude clipboard contents.
- Exclude API keys, bearer tokens, auth tokens, file paths, and private user data.

## Acceptance Criteria

The Windows build is not complete until all of these pass on a real Windows machine:

- Fresh install launches.
- Auth works for Google OAuth and email/password.
- Session restores after restart.
- Logout returns to auth/onboarding without deleting local data.
- First-run onboarding completes.
- Microphone settings link opens the Windows microphone privacy page.
- Microphone device list and test work.
- Default `Control+D` shortcut registers.
- Shortcut press starts recording and release stops recording.
- Focus is captured before Echo shows UI.
- Paste returns to the original target app.
- Copy fallback works when paste cannot happen.
- Groq transcription works.
- Groq cleanup works and can be disabled.
- Local small model downloads, verifies, transcribes, and can be deleted.
- Local medium model downloads, verifies, transcribes, and can be deleted.
- History save, search, copy, delete, and clear confirmation work.
- Disabled history does not save new transcript text.
- Dictation insights update and can be cleared independently.
- Notepad autosaves, copies, deletes, previews markdown, and accepts dictation insertion.
- HUD states work: idle, hover, recording, processing, success, copied/no-target, and error.
- Tray/menu commands work while main window is hidden.
- Launch at login toggle reflects real Windows startup state.
- Light, Dark, and System themes are legible.
- No plaintext Groq API key is written to config.
- Diagnostics contain no transcript, notes, audio, clipboard, paths, or secrets.
- Installer runs on a clean Windows account.

## Manual QA Matrix

Run this before calling the Windows app production-ready:

- Auth:
  - Google success.
  - Google cancel/failure.
  - Email sign-up.
  - Existing email.
  - Invalid login.
  - Unverified email.
  - Password reset.
  - Logout.
  - Restart session restore.
  - Offline launch with existing session.
- Onboarding:
  - Fresh install.
  - Existing config.
  - Mic denied/regranted.
  - Missing provider.
  - Missing local model.
  - Shortcut conflict.
  - Skip path if product owner keeps it.
  - Full dictation test.
- Dictation targets:
  - Notepad.
  - Word.
  - Outlook.
  - Teams or Slack.
  - Chrome.
  - Edge.
  - VS Code.
  - Browser text field that was previously unfocused.
  - Minimized target.
  - Multiple monitors.
- Providers:
  - Groq model test.
  - Groq transcription.
  - Groq cleanup disabled.
  - Groq cleanup failure fallback.
  - Local small.
  - Local medium.
  - Model download failure.
  - Model integrity failure.
- Local data:
  - History limit.
  - History disabled.
  - Clear history.
  - Clear insights.
  - Notepad create/edit/delete/copy.
- Lifecycle:
  - Close hides app.
  - Tray opens app.
  - Tray start/stop dictation.
  - Tray history/settings.
  - Quit exits fully.
  - Single instance.
  - Launch at login.
- Release:
  - Build production app.
  - Install on clean Windows user.
  - Confirm no secrets in config/logs.

## Implementation Plan

Work in this order:

1. Scaffold app shell, secure storage, config, and theme tokens.
2. Implement auth and deep-link callbacks.
3. Implement onboarding readiness checks.
4. Implement audio recording, shortcut press/release, and HUD state.
5. Implement focus capture, clipboard write, focus restore, and `Ctrl+V` paste.
6. Implement Groq transcription and cleanup.
7. Implement local Whisper model download, verify, cache, and transcription.
8. Implement History, Insights, and Notepad.
9. Implement Settings, tray/menu lifecycle, launch at login, diagnostics.
10. Run full Windows manual QA and fix platform-specific failures.

Do not mark the Windows app complete because the macOS app works. The Windows core loop must be proven on Windows.
