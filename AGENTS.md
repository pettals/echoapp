# AGENTS.md

- If using XcodeBuildMCP, use the installed XcodeBuildMCP skill before calling XcodeBuildMCP tools.

Use the smallest appropriate model and intelligence setting for the task.

- For small UI, copy, styling, and simple component edits: use GPT-5.4 Mini with Low intelligence.
- For normal feature implementation: use GPT-5.5 with Medium intelligence.
- For architecture, native macOS/Tauri work, screen recording, permissions, global shortcuts, or difficult debugging: use GPT-5.5 with High intelligence.
- Do not use Extra High unless the task has failed multiple times or involves complex multi-file debugging.

Before starting a task, state the recommended model and intelligence level.

If the current model seems excessive for the task, suggest switching down. If the task is too complex for the current setting, suggest switching up before coding.

## Repo-Specific Guidance

- `Echo` is a Tauri 2 desktop dictation app. Frontend code lives in `src/`; Rust/Tauri code lives in `src-tauri/src/`.
- Product priority is macOS polish first, with Windows kept functionally working.
- Treat permissions, Accessibility paste automation, focus restore, tray/menu bar behavior, global shortcuts, and dock indicator work as high-risk native changes.
- Do not assume a behavior works on Windows because it works on macOS. Verify platform-specific branches before changing shared flows.
- If changing permission UX, paste automation, focus restore, tray behavior, or indicator behavior, use GPT-5.5 with High intelligence.
- Groq API keys must stay in OS secure storage. Do not store secrets back into plaintext config files such as `config.json`.
- Any `AppConfig` changes must remain backwards compatible with serde defaults and existing local configs.
- Respect `history_enabled` and `history_limit` when touching transcript history.
- Preserve the setup-readiness flow: provider/model readiness, microphone readiness, shortcut validation, and paste permission guidance.
- First-run and error states should always leave the user with a clear next step. Do not silently fail or dump users into Settings without context.
- On macOS, if Accessibility automation is unavailable, preserve clipboard-copy fallback rather than failing hard.
- If changing frontend behavior, run `npm run build`.
- If changing Rust/Tauri behavior, run `cargo check --locked` in `src-tauri`.
- If touching both sides, run both checks.
- Existing `objc` macro warnings from the macOS private API path are known. Call out only new warnings or changed failure modes.
- Keep `PRD.md` and `TASKS.md` in sync when production work meaningfully changes scope or status.
