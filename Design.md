# Echo Design System Reference

This document is the design-system handoff for building Echo on Windows while staying aligned with the current app. It covers UI language, layout, visual tokens, and component behavior. For the complete product behavior contract, use `docs/WINDOWS_REBUILD_PROMPT.md`; for product scope and release criteria, use `PRD.md`.

Echo is a desktop dictation utility from Pettal Technology. The app should feel calm, compact, and production-ready: a square desktop window with a persistent branded gradient sidebar, one scrollable workspace, graphite-first surfaces, and a restrained purple accent drawn from the Echo dolphin mark.

## Direction

- Dark mode is the default for new, missing, or invalid configs. Light and System remain user-selectable and must stay legible. The signed-in sidebar keeps its dark brand gradient in every theme.
- Keep Echo desktop-first: fixed left navigation, one main scrollable workspace, compact controls, clear hierarchy, and no mobile tab-bar layout.
- Let whitespace, typography, and neutral surfaces carry the interface. Accent should be restrained and contained.
- Use the purple-to-magenta brand family for the sidebar, selection, focus, progress, and temporary milestone feedback. Signed-in primary actions use high-contrast monochrome fills.
- Use green, amber, and red only for meaningful success, warning, and error states.
- Avoid decorative glows and gradients on ordinary cards, rows, metrics, and navigation.
- Native transparency, blur, vibrancy, or Mica may enhance the app, but CSS token surfaces must stand alone without those materials.

## Tokens

Design tokens live in `src/App.css`: `:root` contains the dark defaults and shared brand anchors, while `.window-root[data-theme="light"]` overrides the concrete light-theme values.

- Radius: `8px-9px` controls and text buttons, `14px` groups, and full pills only for toggles, circular icon buttons, shortcut keycaps, small status tags, and the HUD.
- Typography: use the native macOS and Windows system stacks with no external font request. Use `13px-14px` for controls and body copy, `11px-12px` for secondary labels, `14px` medium-weight sidebar labels, and approximately `28px` for page headings.
- Surfaces: use one neutral hierarchy of graphite page background, grouped surface, inset control surface, and overlay in dark mode, with cool-neutral equivalents in light mode. Ordinary groups and rows do not cast shadows; elevation is reserved for dialogs, menus, and temporary overlays.
- Brand anchors: `--brand-purple` is `#7C5CFF`, `--brand-magenta` is `#C81D8E`, `--brand-coral` is `#FF7A72`, and `--brand-gradient` reproduces the full logo range for decorative use.
- Interactive accents: `--accent`, `--accent-strong`, `--accent-purple`, `--accent-soft`, `--accent-border`, and `--accent-gradient` provide contrast-safe controls and selected states in each theme.
- Semantics: `--success`, `--info`, `--warning`, `--error`, and their soft variants remain visually distinct from the brand palette. `--progress-fill` uses the interactive accent gradient.
- Motion: hover/focus/state transitions stay around `120ms-180ms`. Prefer color, opacity, border, transform, and contained glow. Reduced-motion users get fades or instant state changes.

## Main Layout

- App shell: `.app-shell` is a square, opaque outer window using an approximately `196px` sidebar and a flexible main column. It fills the Tauri window bounds and uses `border-radius: 0`. Workspace palette overrides remain scoped to `.app-shell` and `.window-root--notepad` so the separate HUD window cannot inherit them.
- Main content: `.main-content` is inset from the outer shell, rounded with `--radius-lg`, and uses the tokenized content background. The rounded inner panel is the visible "right window" treatment; do not round the outer window.
- Sidebar: show the white Echo dolphin mark plus "Echo" wordmark at top, primary navigation in the middle, and Settings pinned to the footer. Use a static, restrained purple-pink gradient in both light and dark themes. Rows use one Lucide icon and a `14px` medium white label; inactive rows use opacity for hierarchy, while the active destination receives a translucent white surface and inner border.
- Content body: one scrollable central column with restrained width. Dictate, History, and Settings are centered at roughly the same maximum width; Notepad can use a wider split workspace.
- No right context column, search-first navigation, music-dashboard framing, or landing-page composition. The first signed-in app screen is the usable Dictate dashboard.

## Screens

- Auth and onboarding: first-run surfaces use the Echo brand, clear next steps, and direct setup guidance. States must handle sign-in, email verification, password recovery, microphone readiness, paste readiness, shortcut validation, provider/model readiness, test dictation, skip/reopen onboarding, and completion.
- Dictate dashboard: lead with a quiet state module showing the current customer-facing state (`Ready`, `Listening`, `Transcribing`, `Pasted`, `Copied`, or an actionable error), a platform-rendered shortcut, and only the message needed now. Do not expose provider or model metadata in the daily workflow.
- Insights: keep the disclosure collapsed by default with all-time word count in its summary. Expanded content shows total words, rolling WPM, day streak, and milestone as plain grouped values. Safe timing diagnostics live in a nested, closed `Last dictation details` disclosure. Milestone celebrations remain contained and temporary.
- Navigation: do not repeat Notepad, History, or Settings as Home tiles. Show a setup action only when readiness is blocked.
- History: grouped transcript rows with timestamp/status metadata, search, empty states, clear confirmation, and icon actions for copy/delete. Row actions may become more visible on hover.
- Notepad: split list/editor workspace with search, active note rows, autosaved editor, markdown preview support, copy/delete actions, dictation status, and empty states.
- Settings: keep compact `Account`, `Dictation`, `Input`, and `App` tabs. Use grouped rows, dividers, and progressive disclosure instead of icon-led nested cards. Healthy readiness has no persistent banner; a failing check gets one compact notice and next action. Keep the primary Pro surface in Account, reveal provider controls contextually, place technical tuning in `Advanced`, and show Save/Discard only while the form differs from saved configuration.
- Standalone Notepad window: separate Tauri window using the same token language, but it does not need the full main app sidebar layout.
- Dynamic Island HUD: separate always-on-top surface with idle, hover-expanded, recording, processing/transcribing, success, copied fallback, no-target copy review, and error states. Keep it compact, token-compatible, and independent from the main window layout.

## Windows Translation

- Never display raw `CommandOrControl`. Render shortcuts with platform-appropriate macOS glyphs or Windows labels.
- Windows UI copy must say "Paste readiness", not "Accessibility". The macOS Accessibility permission concept does not apply to Windows.
- Confirm that Echo uses clipboard write plus `Ctrl+V` simulation on Windows, and always preserve copy-to-clipboard fallback messaging.
- Best-effort Mica or transparency may be used only as an enhancement. The solid token surfaces from `src/App.css` are the readability source of truth.
- Do not copy macOS-only window assumptions. Keep the app visually aligned, but validate titlebar, focus, overlay, tray, shortcut, paste, and installer behavior on real Windows hardware.
- Browser preview and Windows builds should look complete without native window materials.

## Theme Behavior

The user-facing appearance preference is `appearance_theme: "system" | "light" | "dark"` in `AppConfig`. Defaults use `"dark"`, existing saved configs keep their stored preference, and missing or invalid frontend values normalize to `"dark"`.

React resolves `"system"` with `prefers-color-scheme` and applies the concrete theme through `data-theme="light"` or `data-theme="dark"` on each Tauri window root. Every surface and state must work in both concrete themes.

## Component Rules

- Use primitives from `src/components/ui.tsx` before adding one-off controls, including `SettingsGroup`, `SettingsRow`, `Disclosure`, and contextual `InlineNotice`.
- Use the shared Lucide wrapper with a consistent stroke width. Retain icons for navigation, state, icon-only actions, and semantic warnings; do not add decorative section icons or icons to text actions.
- Primary buttons use monochrome contrast: off-white with dark text in dark mode and near-black with off-white text in light mode. Secondary buttons use neutral control surfaces; destructive actions use the error token.
- Form inputs and selects use a `46px` height, visible labels, `8px` radius, inset neutral surfaces, and a purple focus ring in both themes.
- Use segmented controls for exclusive choices such as Appearance, toggles for booleans, selects for model/device/sound choices, and icon buttons for repeated copy/delete/refresh actions.
- Show readiness only when a check fails. Name the first blocker, provide one next action, and place remaining checks behind `Details`.
- Use a compact Cloud/On-device selector. Locked features point to the centralized Account plan row instead of rendering repeated paywall cards.
- Render global shortcuts as separate `.shortcut-key` keycaps using platform labels.
- Keep first-run, paywall, setup, and error states actionable with one clear next step.
- Keep secure-storage language precise: Groq API keys are saved in the OS credential store, not in plaintext config.

## Avoid

- Reintroducing MUI or Emotion for core app UI.
- One-off color values outside the token system unless a semantic token is missing.
- Rounded translucent outer windows, right context columns, music-dashboard layouts, search-first sidebars, or blue/green primary active accents from older references.
- Mobile-only layouts, oversized nonfunctional artwork, nested cards, or generic landing-page composition.
- Decorative section icons, differently colored metric cards, duplicate navigation tiles, repeated Pro promotions, and persistent success alerts.
- Remote font dependencies, raw internal error language in primary UI, or descriptions that merely repeat their control labels.
- Shadows on ordinary cards and settings rows.
- Rounding the outer window/material in a way that exposes transparent corners under native window effects.
- UI that depends on blur, vibrancy, Mica, or transparency for legibility.
- UI that only works in dark mode, or a light-theme sidebar treatment that drops the persistent brand gradient.
- Workspace token changes that leak into `.window-root--indicator` or alter the Dynamic Island HUD.
- Mac-only Accessibility copy in Windows setup or Settings.
- A required Start button on the Dictate dashboard; dictation is driven by the global shortcut, tray/menu commands, and HUD actions.

## Related Docs

- `docs/WINDOWS_REBUILD_PROMPT.md`: complete Windows behavior and implementation handoff.
- `PRD.md`: product scope, requirements, risks, and release criteria.
- `src/App.css`: source of truth for tokens, layout, themes, and visual states.
- `src/App.tsx` and `src/components/Settings.tsx`: source of truth for current screen structure and copy patterns.
