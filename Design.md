# Echo Design System Reference

Echo uses a custom React/CSS design system for a focused macOS-first desktop dictation utility. The current target is a calm, sophisticated, whitespace-led macOS panel language: a square app window that hosts a roomy icon sidebar and a floating rounded content panel, with a magenta-to-purple accent drawn from the Echo dolphin logo and green reserved for success/readiness.

## Direction

- Dark mode is the main experience and the default for new, missing, or invalid configs. Light and System remain user-selectable and must stay legible.
- Keep Echo desktop-first: fixed left navigation, one main scrollable workspace, compact controls, generous whitespace, and no mobile-tab-bar layout.
- Let whitespace and typography lead. Prefer calm neutral surfaces with restrained, contained accent rather than full-window decoration.
- Magenta-to-purple is the single primary accent (from the dolphin logo). Use it for active navigation, primary buttons, progress, focus rings, the hero mark, and small selected-state touches. Keep green for success/readiness.
- Gradients and glow are allowed when contained inside the hero, panels, progress bars, active rows, and the logo mark. Avoid full-window rainbow decoration.
- Use translucency and blur as polish, not as a dependency for readability. Solid fallback surfaces must still work.

## Tokens

Design tokens live in `src/App.css` under `.window-root[data-theme="dark"]` and `.window-root[data-theme="light"]`.

- Radius: `8px`, `10px`, `14px`, `18px`, `24px`, with pills for chips, the shortcut keycaps, and the indicator. The floating content panel uses `--radius-lg`; the Dictate hero uses `--radius-xl`.
- Typography: SF Pro stack, `13px` default control/body size, `11-12px` labels, `22-28px` hero/page titles, and heavier display weights reserved for stats.
- Surfaces: window, sidebar, content, card, raised surface, muted surface, active surface, hover surface, control surface, and player surface.
- Semantics: `--accent` is magenta, `--accent-strong` a brighter magenta, `--accent-purple` the purple companion, `--accent-gradient` the magenta-to-purple gradient, `--success` is green, `--info` is violet, `--progress-fill` is the magenta-to-purple gradient, plus warning/error/text/border tokens.
- Motion: hover/focus transitions stay under `180ms`; prefer color, border, opacity, transform, and contained glow. Reduced-motion users get fades only.

## Layout

- App shell: a square outer window (`.app-shell`, fixed `216px` sidebar + main column) that fills the window bounds. The outer window stays square and opaque so native macOS vibrancy never exposes transparent corner cut-outs.
- Floating content panel: `.main-content` is inset from the window edges with a margin, `--radius-lg` corners, a thin border, and a soft shadow, so it reads as an elevated card floating on the sidebar/window tone (the rounded "right window" treatment).
- Sidebar: dolphin logo mark plus "Echo" wordmark at top, well-spaced icon + label destinations, and Settings pinned to the footer. The active row is a soft filled pill with a thin accent ring and an accent-tinted icon (no hard edge bar).
- Dictate view: a centered hero (status glyph mark, title, hint, and the global shortcut shown as keycaps) that updates in place for recording/processing/result states, followed by a labeled insights row, a row of quick-action tiles (Notepad, History, Check setup, Settings), and setup readiness shown only when blocked. There is no Start button; dictation is triggered by the global shortcut or menu bar.
- Insights: clean stat cards (total words, WPM, day streak, next-milestone progress) with restrained accent glows.
- History view: grouped rows with timestamp/status metadata and icon actions that become fully visible on hover.
- Notepad view: split note list/editor workspace with active rows and editor surfaces using the same panel treatment.
- Settings view: grouped form sections, icon-led headers, magenta primary actions, green success/provider states, and sticky Save/Cancel actions. All settings sections are preserved.
- Indicator (Dynamic Island HUD) and standalone notepad are separate surfaces; keep them compatible with tokens but do not force the main-window layout onto them. The HUD is intentionally left as-is.

## Theme Behavior

The user-facing appearance preference is `appearance_theme: "system" | "light" | "dark"` in `AppConfig`. New/default configs use `"dark"`. Existing saved configs keep their stored preference. Missing or invalid frontend values normalize to `"dark"`.

React resolves `"system"` with `prefers-color-scheme` and applies the concrete theme through `data-theme="light"` or `data-theme="dark"` on each Tauri window root.

## Platform Behavior

- Native macOS can use transparent window/vibrancy plumbing as a subtle enhancement, but CSS surfaces carry the actual app readability.
- The outer window stays square; only the inner content panel is rounded. Do not round the outer window/material, which can expose transparent cut-outs at app corners.
- Windows keeps best-effort Mica as enhancement only. The CSS token surfaces must stand alone.
- Browser preview should look complete without native window materials.

## Component Rules

- Use primitives from `src/components/ui.tsx` before adding one-off controls.
- Primary buttons use the magenta accent; secondary buttons use smoked neutral control surfaces.
- Success/readiness states use green; progress bars use the magenta-to-purple gradient.
- The Echo logo mark fills the `echo-logo.svg` silhouette with `--accent-gradient`; keep it crisp and small in the sidebar.
- Render the global shortcut as individual keycaps (`.shortcut-key`) using platform glyphs.
- Use segmented controls for exclusive appearance choices and toggles for binary settings.
- Prefer icon buttons for repeated row actions such as copy/delete.
- Keep first-run and error states actionable with one clear next step.
- Preserve clipboard-copy fallback messaging when Accessibility paste automation is unavailable.
- Keep macOS menu commands in sync with primary flows: Start/Stop Dictation, Dictate, History, Settings, Check Setup, Hide, and Quit.

## Avoid

- Reintroducing MUI or Emotion for core app UI.
- One-off color values outside the token system unless a semantic token is missing.
- Mobile-only layouts, brand-copying reference images, nested cards, or oversized nonfunctional artwork.
- Rounding the outer window/material in a way that exposes transparent corners under macOS vibrancy.
- Uncontained glow that competes with content.
- UI that only works in dark mode: light/system remain user-selectable and must stay legible.
