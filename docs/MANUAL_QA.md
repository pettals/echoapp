# Echo Manual QA Checklist

Use this checklist before marking release lifecycle tasks complete.

## Local-first Meetings (release gate)

- Install a signed build on a clean Apple Silicon Mac, an Intel/macOS 13–14 Mac, and a Windows 10/11 x64 PC without developer runtimes. Confirm the nested capture and notes helpers launch; on Mac verify their architectures and signatures. Bark is offered only on Apple Silicon/macOS 15+; all other supported Meetings systems use Whisper.
- Sign in once with a verified Pro purchase, disconnect the network, restart Echo, and record, transcribe, summarize, search, edit and export a meeting entirely offline. Tamper with the saved licence, sign into another account, and verify an authoritative online revocation blocks new Pro work while saved meetings remain readable and deletable.
- Record both **In-person** (microphone only) and **Online** (microphone plus default computer output) from Meetings and from the expanded HUD. Check permission denial/recovery, input levels, duration, pause/resume, stop and the four-hour automatic limit. Dictation hotkeys must not take over capture, and dictation history, Notepad and clipboard fallback must still work.
- Test silence, overlapping speakers, headphones and speakers, Bluetooth/default-device changes, app sleep/wake, quit/crash and disk exhaustion. Confirm useful recovery/discard for interrupted audio. Inspect the private library: audio chunks are removed after their transcript rows commit, and deleting a meeting removes outstanding audio/journals. No video or speaker identity should be stored.
- Check the raw-ASR view against the assembled transcript, especially Bark's deliberate filler removal and online playback echo. Verify every substantive note's timestamp opens its source, and corrections, negations, disputed decisions, unnamed owners and absent deadlines are represented accurately. Use a four-hour recording with important facts near both ends; no section may disappear during summarization.
- With network blocked after model download, verify no meeting content leaves the computer. Save a provider key and confirm no transcript request occurs until that provider and the separate consent setting are saved. Switch among OpenAI, Gemini, Claude and local, then test invalid keys, quota errors, malformed responses and failed regeneration; the transcript and last good notes must survive.
- Rename, edit, search, copy, export Markdown/text and delete meetings. Disable Pro and repeat read/export/delete. Test both original and assembled transcript exports. Verify source files and exports never enter diagnostics or analytics.

## Bark 3 Clean

- On Apple Silicon/macOS 15+, Settings → Dictation → On-device shows Bark 3 Clean with English-only, built-in cleanup and about 427 MiB download copy. Existing selected/default Whisper models stay selected.
- A free account can download, verify, select and remove Bark without Echo Pro or a Groq API key. All 21 files must be complete and verified before it becomes ready.
- Interrupt a download, exhaust free disk space, and corrupt/truncate a model file: readiness must stay incomplete, show an actionable retry/verification error, and permit recovery. Restarting Echo must not treat a `.part` directory as installed.
- The first dictation may show preparation for about a minute; subsequent dictations report a cache hit. Test English with fillers/false starts, silence, short audio, and a recording longer than 15 seconds. No `<unk>` markers or text carried from the previous recording should appear.
- Test hotkey release → paste, manual recording, inline and standalone Notepad insertion, copied fallback with Accessibility denied, history disabled, and capped history. All use Bark's final transcript without a cloud cleanup pass.
- Select cloud mode with Bark installed, then lose Pro verification/connectivity: the temporary local fallback uses Bark without overwriting the saved provider. No usable local model must produce a reconnect/download next step.
- Switch Bark → Whisper → Bark, remove Bark while it was selected, close/reopen Echo, and quit during transcription. The helper should release on switching/removal and exit with Echo. A failed helper must yield a recoverable error and restart on retry.
- On Intel Macs, macOS below 15, and Windows, Bark is unavailable with a clear explanation. A copied config selecting Bark must prompt the user to choose Whisper, rather than silently changing the saved selection.
- On a clean Mac without Python, Swift or developer tools, test the packaged helper and its resource bundle. Verify nested signing and repeat the existing permissions/tray checklist.

## Tray And Menu Lifecycle

- `Open Echo` brings the main Echo window forward from hidden/minimized state.
- `Start Dictation` starts recording from the tray/menu bar menu.
- `Stop Dictation` stops the active recording and continues the normal paste/copy flow.
- `View History` brings Echo forward and opens the History tab.
- `Settings` brings Echo forward and opens Settings.
- Closing the main window hides Echo but keeps global shortcut and tray/menu bar controls alive.
- `Quit Echo` fully exits the app and removes tray/menu bar controls.

## Notes

- On macOS, verify after hiding the window with the red traffic-light close button.
- On Windows, repeat this checklist only after Windows QA hardware is available.

## Launch At Login

- The `Launch Echo at login` toggle is off by default on a fresh config.
- Enabling the toggle and saving Settings registers Echo with the operating system startup/login items.
- Reopening Settings reflects the current operating system launch-at-login state.
- Disabling the toggle and saving Settings removes Echo from startup/login items.

## Function-Key Shortcuts

- Settings and onboarding offer F1-F24 without requiring the key to be captured physically.
- Selecting an F key follows the existing save, validation, and registration flow.
- On macOS with default top-row behavior, holding Fn/Globe with the selected F key starts dictation and releasing it stops dictation.
- The bare top-row key keeps its brightness, volume, or media action when standard function keys are disabled.
- With `Use F1, F2, etc. keys as standard function keys` enabled in macOS, the selected F key works without Fn/Globe.
- Existing captured shortcuts such as Command+D continue to register and run normally.
- On an extended keyboard, verify at least one available F13-F24 key.
