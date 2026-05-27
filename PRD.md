# Echo Production PRD

## Product Goal

Echo lets users hold a global shortcut, speak naturally, and have clean text pasted into the previously focused app with minimal friction.

## Primary Audience

The primary audience is macOS users who frequently dictate into chat, docs, email, notes, IDEs, and browser fields. Windows users are secondary, but the core dictation loop must work reliably there too.

## Core Success Criteria

- First-run setup guides users through microphone readiness, Accessibility/paste permissions, provider choice, shortcut setup, and mic validation.
- Dictation works end to end: capture focus, record, transcribe, optionally clean up, paste or copy as fallback, and save history.
- macOS feels native: menu bar behavior, hidden-window mode, dock indicator, permission messaging, and a clear signing/notarization path.
- Windows supports shortcut, recording, transcription, clipboard paste/fallback, settings, history, and installer builds.
- Failures are understandable and recoverable, especially missing API key, missing local model, denied microphone access, denied paste automation, network failures, and unavailable audio devices.

## In Scope For Production v1

- macOS-first polish and QA.
- Groq provider and local Whisper provider.
- Download and manage local small and medium Whisper models.
- Transcription history with copy, delete, and clear.
- Local Notepad for autosaved notes, markdown preview, copy/delete, and note-specific dictation insertion.
- Configurable shortcut, mic device, sounds, provider, and model choices.
- Tray/menu bar app lifecycle.
- Production packaging, signing/notarization plan, and release checklist.

## Out Of Scope For v1

- Mobile builds.
- Multi-language UI.
- Team accounts/sync.
- Full local LLM cleanup unless added after the core app is stable.

## Product Requirements

- First run must not strand users in Settings without a clear next action.
- Echo must expose a visible setup state for mic, shortcut, provider/model, and paste permissions.
- Auto-paste must gracefully fall back to copying without losing the transcript.
- If no external paste target is captured, the persistent HUD must show the transcript with a copy action and a short countdown before returning to idle.
- History must be bounded, user-clearable, and documented.
- Notepad notes must remain local, autosave while editing, and support dictation insertion without triggering external paste automation.
- Local mode must explain model sizes, disk use, download state, and offline behavior.
- Windows must not present macOS-only affordances as working features.
- The desktop UI should use the custom Echo design system: clean light/dark themes, persistent sidebar navigation, quiet native surfaces, compact desktop density, and reduced-motion-aware transitions.

## Production Risks

- macOS Accessibility/AppleScript paste flow needs explicit permission onboarding and real-app testing.
- Windows media ducking is currently a no-op.
- Shortcut capture needs validation and conflict feedback.
- API key storage must use OS secure storage rather than plain JSON.
- Release process needs CI, signed builds, an update strategy, and a QA matrix.
