# Echo Windows Bring-Up Tasks

Use this document on a real Windows 10/11 machine to bring the existing Echo repository to a tested Windows build. This is a compatibility and release-readiness pass, not a rewrite. The existing React/Tauri application remains the source of truth, and macOS behavior must continue to work.

The longer product-level Windows reference is in `docs/WINDOWS_REBUILD_PROMPT.md`. This document is the executable task sequence for a Windows colleague working with Codex.

## Prompt To Give Codex

```text
You are working on Echo, a Tauri 2 desktop dictation app. Complete the next unchecked task in docs/WINDOWS_CODEX_TASKS.md on this real Windows machine.

Use GPT-5.5 with High intelligence for native Windows, focus restoration, paste automation, permissions, global shortcuts, tray, secure storage, and installer work. Before changing code, inspect AGENTS.md and the task's dependencies. Preserve macOS behavior and all documented clipboard fallbacks. Do not store Groq keys or auth tokens in plaintext files or logs.

For every task:
1. Reproduce or establish the current Windows behavior first.
2. Make the smallest cross-platform-safe change.
3. Run npm run build, cargo check --locked, and cargo test --locked.
4. Run the task-specific Windows checks on the real machine.
5. Record commands, results, Windows version, architecture, and relevant screenshots/logs without secrets.
6. Update only the completed task's evidence section and checkbox.
7. Do not call Windows production-ready until W0-W11 are complete. W12 additionally requires the product owner's signing decision and credentials.
```

## Rules And Safety Gates

- Work on a branch such as `codex/windows-bring-up`; do not push directly to `main` unless explicitly asked.
- Do not remove macOS code to make Windows compile. Use target-specific dependencies and `cfg` branches.
- Groq API keys and auth sessions must remain in Windows Credential Manager through the native `keyring` backend.
- Preserve backwards-compatible config defaults and migration from legacy plaintext Groq keys.
- Always write the transcript to the clipboard before attempting focus restoration or `Ctrl+V`.
- A failed focus restore or paste must leave the transcript available to paste manually and show a clear next step.
- Respect `history_enabled`, the free history cap, and paid entitlement verification.
- Never put transcript text, note contents, audio, clipboard contents, keys, tokens, or private paths in diagnostics or issue evidence.
- Do not assume success because macOS CI passes. Windows build and runtime evidence are required.

## Windows Workstation Prerequisites

Install these before W0:

- Windows 11 or a supported Windows 10 release, fully updated.
- Git for Windows.
- Node.js 20 LTS and npm.
- Rust stable using the MSVC toolchain (`stable-x86_64-pc-windows-msvc`).
- Visual Studio 2022 Build Tools with **Desktop development with C++**, MSVC, CMake tools, and a Windows 10/11 SDK.
- Microsoft Edge WebView2 Runtime.
- PowerShell 5.1 or PowerShell 7.
- At least 5 GB free for dependencies and builds; at least 8 GB more when testing both local Whisper models.
- A working microphone and permission to change Windows microphone/privacy and startup settings.
- Test accounts for Supabase/Echo and Groq. Stripe test access is needed for billing checks.

Record the Windows edition/build, CPU architecture, microphone, display scaling, and number of monitors in the final evidence.

## Standard Validation Commands

Run from PowerShell at the repository root unless noted:

```powershell
git status --short --branch
node --version
npm --version
rustc --version
cargo --version
npm ci
npm run build

Push-Location src-tauri
cargo check --locked
cargo test --locked
Pop-Location

npm run tauri dev
```

For production bundle checks:

```powershell
npm run tauri build -- --bundles nsis
npm run tauri build -- --bundles msi
```

If one installer format is intentionally excluded, document the decision and remove only that command from the relevant acceptance criteria.

## Definition Of Done For Every Task

- The task's acceptance criteria pass on the Windows machine.
- `npm run build`, `cargo check --locked`, and `cargo test --locked` pass.
- No new macOS regression is knowingly introduced.
- Errors leave a clear recovery action and preserve clipboard fallback where applicable.
- Evidence contains no secrets or customer content.
- Code, tests, and relevant documentation are committed together.

---

## W0 — Establish The Windows Baseline

**Type:** HITL
**Blocked by:** None

### What to achieve

Create a reproducible baseline from the current `main` branch before fixing anything. Confirm the toolchain, capture the first frontend/Rust/Tauri failures, and separate environment problems from repository problems.

### Work

1. Clone or pull `https://github.com/pettals/echoapp` and create `codex/windows-bring-up`.
2. Record `git rev-parse HEAD` and the workstation details listed above.
3. Run the standard validation commands without editing code first.
4. Save concise error output for failed commands. Redact usernames, tokens, keys, and private paths.
5. Confirm that WebView2 and the Visual C++ toolchain are available.

### Acceptance criteria

- [ ] Repository commit and Windows/toolchain versions are recorded.
- [ ] `npm ci` and `npm run build` have a recorded pass/fail result.
- [ ] Locked Rust check and tests have a recorded pass/fail result.
- [ ] `npm run tauri dev` has a recorded launch result.
- [ ] Every baseline failure is classified as environment, compile, packaging, or runtime.

### Evidence

Add results here when completed.

---

## W1 — Make Windows Compile And Keep It Compiling In CI

**Type:** AFK after W0 captures the failure
**Blocked by:** W0

### What to achieve

Produce a clean Windows frontend build, locked Rust check, Rust test run, and Tauri development launch. Add a Windows CI job so later changes cannot silently break the platform.

### Known starting issue

Windows code imports the Mica helper from `window-vibrancy`, while the dependency is currently declared only for the macOS target. Move that dependency into an appropriate Windows/macOS target section or otherwise make the dependency graph correct without exposing macOS-only crates to unsupported targets.

### Work

1. Fix all Windows compile errors with target-specific changes.
2. Add `windows-latest` CI coverage for `npm ci`, `npm run build`, `cargo check --locked`, and `cargo test --locked`.
3. Keep the existing macOS CI job.
4. Launch the Tauri development app and confirm the main window renders.

### Acceptance criteria

- [ ] Standard validation commands pass on Windows.
- [ ] `npm run tauri dev` launches the app without a panic or blank main window.
- [ ] GitHub Actions checks both macOS and Windows.
- [ ] No secrets or machine-specific paths are added to the repository.

### Evidence

Add results and CI run URL here when completed.

---

## W2 — Prove Windows Window, Tray, And Process Lifecycle

**Type:** HITL
**Blocked by:** W1

### What to achieve

Make Echo behave like a Windows background utility: closing hides it, the tray restores it, single-instance behavior works, and quitting really exits.

### Work

1. Verify main, HUD/indicator, and Notepad windows open with correct size and Windows decorations.
2. Verify Mica/backdrop failure is harmless on unsupported Windows versions.
3. Verify closing the main window hides Echo while global shortcuts and tray actions stay alive.
4. Test every tray action: Open, Start Dictation, Stop Dictation, View History, Settings, Quit.
5. Launch Echo twice and verify the existing instance is brought forward without duplicating tray icons.
6. Enable and disable launch at login, restart Windows, and confirm the setting reflects actual startup state.
7. Use Windows-appropriate tray artwork; do not rely on a macOS monochrome template flag for final Windows rendering.

### Acceptance criteria

- [ ] Close hides rather than exits.
- [ ] Tray actions work while the main window is hidden.
- [ ] Quit removes the process and tray icon.
- [ ] Second launch reuses the existing instance.
- [ ] Launch at login survives an OS restart and can be removed.
- [ ] Tray icon is legible on light and dark Windows taskbars.

### Evidence

Add screenshots and results here when completed.

---

## W3 — Prove Authentication, Deep Links, Entitlements, And Secure Storage

**Type:** HITL
**Blocked by:** W1, W2

### What to achieve

Complete the account lifecycle on Windows while proving that credentials persist only in Windows Credential Manager and never leak into config or logs.

### Work

1. Test email sign-up, verification pending, login, invalid login, password-reset entry, logout, and session restore after app restart.
2. Test Google OAuth through the configured web bridge and `echo://auth/callback`.
3. Test billing complete/cancel deep links and Echo Pro restore using Stripe test mode.
4. Verify free/pro feature gating and temporary local fallback when online entitlement verification fails.
5. Save and reload a Groq key; inspect config and safe logs to confirm the key is absent.
6. Verify legacy plaintext-key migration writes to Credential Manager before sanitizing config.
7. Verify logout does not leak entitlement or auth state into another account.

### Acceptance criteria

- [ ] Email/password and Google OAuth flows return correctly to Echo.
- [ ] Session survives app and Windows restart.
- [ ] Logout clears account authorization without deleting local history/notes.
- [ ] Echo Pro checkout, cancel, restore, and account switching behave correctly in test mode.
- [ ] Auth session and Groq key persist in Windows Credential Manager until explicitly deleted.
- [ ] Config, logs, diagnostics, screenshots, and evidence contain no tokens or keys.

### Evidence

Record sanitized results here. Never paste credential values.

---

## W4 — Complete Windows First-Run Setup And Shortcut Recording

**Type:** HITL
**Blocked by:** W2, W3

### What to achieve

Let a fresh Windows user complete onboarding, choose/test a microphone, configure a provider, register a shortcut, and pass the first dictation test with Windows-specific guidance.

### Work

1. Test a clean first run and a returning user with an existing config.
2. Verify the microphone device list, selected-device persistence, level test, denial state, and `ms-settings:privacy-microphone` link.
3. Verify Windows says “Paste readiness” and does not show macOS Accessibility instructions.
4. Test inline Groq key verification for an entitled user and On-device setup guidance for a local user.
5. Verify `CommandOrControl+D` renders as `Control+D`.
6. Verify shortcut press starts recording and release stops it; test a replacement shortcut and one registration conflict.
7. Check F1-F24 choices on the available keyboard and confirm modifier-only/invalid shortcuts are rejected.

### Acceptance criteria

- [ ] Fresh onboarding completes without opening raw Settings as an unexplained fallback.
- [ ] Microphone permission denial has a working recovery action.
- [ ] Selected microphone and shortcut persist after restart.
- [ ] Default `Control+D` starts on press and stops on release exactly once.
- [ ] Shortcut conflict and provider failures show one clear next step.
- [ ] First dictation test reaches pasted or copied fallback success.

### Evidence

Add the tested devices and shortcuts here; do not include dictated content.

---

## W5 — Prove The Cloud Dictation Tracer Bullet

**Type:** HITL
**Blocked by:** W3, W4

### What to achieve

Demonstrate one complete Windows user loop using Groq: focus Notepad, hold the shortcut, speak, release, transcribe, restore focus, paste, save history, and update aggregate insights.

### Work

1. Use Windows Notepad as the initial target.
2. Verify the foreground target is captured before Echo/HUD can take focus.
3. Verify recording level and live partial transcript appear without logging content.
4. Verify the final full recording is the source of truth.
5. Test cleanup enabled and disabled.
6. Confirm the transcript is copied before focus/paste automation runs.
7. Confirm history and aggregate stats update according to settings and entitlement.
8. Force a cleanup failure and confirm the original transcript is preserved.

### Acceptance criteria

- [ ] One shortcut hold produces exactly one final transcript in Notepad.
- [ ] Focus returns to the original Notepad field.
- [ ] Cleanup on/off works, and cleanup failure preserves transcription.
- [ ] Clipboard contains the final transcript after the operation.
- [ ] History and stats update without exposing transcript content in diagnostics.

### Evidence

Record pass/fail and timings without transcript text.

---

## W6 — Harden Windows Focus Restore, Paste, And Clipboard Fallback

**Type:** HITL
**Blocked by:** W5

### What to achieve

Make focus restoration and paste reliable across representative Windows applications, while treating clipboard copy as the guaranteed fallback.

### Work

1. Test Notepad, Word, Outlook, Teams or Slack, Chrome, Edge, VS Code, and browser text fields.
2. Test minimized targets, another monitor, 100%/125%/150% scaling, and rapid repeated dictations.
3. Verify Unicode, multiline text, punctuation, emoji, and markdown-like text survive clipboard and paste.
4. Verify Echo never chooses its own main, HUD, or Notepad window as an external paste target.
5. Test a target running elevated and document Windows integrity-level limitations.
6. Force target close, focus-restore failure, and paste-simulation failure.
7. Ensure Control is always released if paste simulation errors midway.
8. Replace the PowerShell clipboard fallback with a direct robust Windows path if testing exposes latency, encoding, policy, or availability problems.

### Acceptance criteria

- [ ] Normal targets paste into the originally focused field.
- [ ] Minimized and multi-monitor targets either paste or produce a clear copied fallback.
- [ ] Elevated-target limitations are handled without transcript loss.
- [ ] Unicode and line breaks are preserved exactly.
- [ ] Failed automation never leaves Control logically pressed.
- [ ] Every failure leaves usable text on the clipboard and an actionable status.

### Evidence

Add a target-by-target result matrix here without transcript content.

---

## W7 — Prove Local Whisper On Windows

**Type:** HITL
**Blocked by:** W4, W6

### What to achieve

Complete the offline On-device path, including model lifecycle, CPU controls, cached reuse, and paste fallback.

### Work

1. Download, verify, use, and delete the small model.
2. Repeat for the medium model if workstation disk/RAM is supported.
3. Interrupt a download and verify partial-file cleanup and retry.
4. Force an integrity mismatch and verify the model is rejected with a recovery action.
5. Compare first transcription with a second transcription and verify the model cache is reused.
6. Test each CPU/thread preset and ensure the UI stays responsive.
7. Disconnect networking after model download and complete a dictation.
8. Confirm local mode never invokes Groq cleanup.

### Acceptance criteria

- [ ] Small and medium model lifecycle passes, or a documented hardware constraint is approved for medium.
- [ ] Interrupted/corrupt downloads cannot be selected as ready models.
- [ ] Second dictation reports model-cache reuse.
- [ ] Offline dictation completes and follows the same paste/copy contract.
- [ ] Temporary recordings and partial downloads do not accumulate.

### Evidence

Record model hashes/status, timings, CPU preset, and sanitized results.

---

## W8 — Verify Local Data And Workspace Features

**Type:** HITL
**Blocked by:** W5, W7

### What to achieve

Verify that History, Insights, Notepad, Settings, themes, and copy actions behave correctly on Windows and remain local.

### Work

1. Test history save, search, copy, delete, clear confirmation, disabled history, free cap, and Pro unlimited behavior.
2. Test insights totals, rolling WPM, streak, milestones, and independent clear action.
3. Test Notepad create, search, autosave, markdown preview, copy, delete, and note-specific dictation insertion.
4. Confirm Notepad insertion does not trigger external `Ctrl+V` automation.
5. Verify all Settings tabs, dirty-only Save/Discard, provider controls, sounds, microphone, shortcut, history, appearance, and startup state.
6. Verify Dark, Light, and System themes at common window sizes and Windows text scaling.
7. Restart after changes and confirm backwards-compatible persistence.

### Acceptance criteria

- [ ] Local data behavior matches settings and entitlement.
- [ ] Notepad insertion stays inside Echo and autosaves.
- [ ] Clearing one local data category does not clear the others.
- [ ] Themes and controls are legible without clipping or horizontal scrolling.
- [ ] Restart preserves valid settings without exposing secrets.

### Evidence

Add sanitized feature results here.

---

## W9 — Harden The Windows HUD, DPI, And Multi-Monitor Behavior

**Type:** HITL
**Blocked by:** W5, W6

### What to achieve

Make the always-on-top HUD useful without stealing focus across Windows scaling and monitor layouts.

### Work

1. Verify idle, hover, recording, processing, success, copied/no-target, and error states.
2. Verify normal shortcut dictation does not activate the HUD or redirect paste into Echo.
3. Test one and two monitors, different primary monitors, negative desktop coordinates, and mixed DPI where available.
4. Test 100%, 125%, 150%, and 200% scaling where practical.
5. Verify the HUD stays on-screen, avoids the taskbar work area, and remains readable.
6. Verify reduced motion and keyboard accessibility.
7. Document or implement the Windows-specific non-activating-window technique if current Tauri flags are insufficient.

### Acceptance criteria

- [ ] All HUD states are visually and functionally correct.
- [ ] HUD does not steal the external target during standard dictation.
- [ ] Geometry remains on-screen across tested DPI/monitor arrangements.
- [ ] Focus/paste still passes after HUD interactions.
- [ ] Reduced-motion behavior is respected.

### Evidence

Add DPI/monitor matrix and screenshots here.

---

## W10 — Verify Windows Sounds, Errors, And Safe Diagnostics

**Type:** HITL
**Blocked by:** W5, W7, W8

### What to achieve

Make Windows feedback predictable and ensure support diagnostics are useful without leaking user content.

### Work

1. Preview every configured sound and verify “None” is silent.
2. Confirm Windows media ducking is intentionally documented as a no-op unless a reliable implementation is added.
3. Trigger missing key, missing model, empty speech, microphone unavailable, paste failure, download failure, integrity failure, network failure, secure-write failure, and shortcut conflict.
4. Verify each error has a stable code, readable message, and next action.
5. Generate diagnostics and inspect them for transcripts, note contents, audio, clipboard contents, API/auth secrets, and private paths.

### Acceptance criteria

- [ ] Sound settings behave consistently on Windows.
- [ ] Media-ducking behavior is accurately described.
- [ ] Required error states are actionable and do not strand the user.
- [ ] Diagnostics contain useful platform/status data and none of the forbidden content.

### Evidence

Add an error-code/result table here. Never paste sensitive payloads.

---

## W11 — Build And Test Unsigned Windows Installers

**Type:** HITL
**Blocked by:** W1-W10

### What to achieve

Produce reproducible unsigned prerelease installers and prove install, upgrade, uninstall, and app protocol behavior on a clean Windows account or VM.

### Work

1. Choose NSIS, MSI, or both for prerelease testing and record the rationale.
2. Build release bundles using the standard commands.
3. Upload installers only as private/prerelease artifacts; do not publish them as a production release.
4. On a clean Windows account/VM, test install, first launch, WebView2 handling, microphone prompt, `echo://` deep links, and core cloud dictation.
5. Test upgrade over the previous test build while preserving config, secure credentials, history, notes, and model files.
6. Test uninstall and document which user data intentionally remains.
7. Confirm the app name, publisher text, version, icons, Start menu entry, and uninstall entry are correct.

### Acceptance criteria

- [ ] At least one installer format builds reproducibly.
- [ ] Clean install and first launch pass.
- [ ] Upgrade preserves intended user data and secure credentials.
- [ ] Uninstall behaves as documented.
- [ ] Deep links and the core dictation loop work from the installed build.
- [ ] Artifact is clearly marked unsigned/prerelease and is not publicly promoted.

### Evidence

Add artifact name/hash and clean-machine results here.

---

## W12 — Add Windows Signing And Release Automation

**Type:** HITL — requires product-owner decisions and signing credentials
**Blocked by:** W11

### What to achieve

Replace the placeholder Windows release job with signed, timestamped, draft-release automation after the unsigned release candidate passes QA.

### Work

1. Product owner selects the final installer target and Windows code-signing certificate provider.
2. Store certificate material/password only in GitHub Actions secrets or the chosen secure signing service.
3. Configure certificate thumbprint/identity and a trusted timestamp URL.
4. Replace the Windows placeholder workflow with build, test, sign, artifact upload, and draft-release steps.
5. Verify signatures with Windows tooling on the downloaded artifact.
6. Run SmartScreen/reputation and clean-machine checks appropriate to the certificate type.
7. Keep releases draft/prerelease until final manual QA is attached.

### Acceptance criteria

- [ ] Signing approach and installer target are approved.
- [ ] CI produces signed and timestamped installers without exposing certificate secrets.
- [ ] Downloaded artifacts verify successfully on Windows.
- [ ] Release remains draft until the W0-W11 evidence and final QA matrix are complete.
- [ ] Rollback and certificate-rotation steps are documented.

### Evidence

Add workflow run, signature verification, and approval references here. Never include certificate material.

---

## Final Windows Release Matrix

Do not mark this complete until the installed release candidate passes all rows.

| Area | Required result | Status |
| --- | --- | --- |
| Compile and tests | Frontend build, locked Rust check, Rust tests, Windows CI | [ ] |
| Authentication | Email, Google OAuth, recovery, restart restore, logout | [ ] |
| Entitlement | Free/Pro, checkout cancel/complete, restore, offline fallback | [ ] |
| First run | Mic, paste readiness, shortcut, provider, first dictation | [ ] |
| Cloud loop | Hold/release, Groq, cleanup, focus restore, paste/copy | [ ] |
| Target apps | Notepad, Word, Outlook, Teams/Slack, Chrome, Edge, VS Code | [ ] |
| Local models | Small and medium download, verify, use, delete, offline | [ ] |
| Local data | History, insights, Notepad, settings persistence | [ ] |
| HUD and display | States, no focus theft, DPI, multi-monitor | [ ] |
| Lifecycle | Hide, tray, quit, single instance, launch at login | [ ] |
| Safety | Secure storage, redacted diagnostics, no secret files/logs | [ ] |
| Installer | Clean install, upgrade, uninstall, deep links | [ ] |
| Signing | Signed, timestamped, verified draft artifact | [ ] |

## Handoff Report Template

```text
Windows version/build:
CPU architecture:
Display/DPI/monitors:
Microphone/device:
Repository commit:
Branch/PR:

Tasks completed:
Tasks blocked:

Commands run and results:
- npm run build:
- cargo check --locked:
- cargo test --locked:
- npm run tauri dev:
- installer build:

Manual QA summary:
Known Windows limitations:
Installer artifact and SHA-256:
CI/release URLs:

Security confirmation:
- No plaintext Groq key or auth token found in config/logs/evidence: yes/no
- Clipboard fallback preserved: yes/no
- Diagnostics inspected for forbidden content: yes/no
```
