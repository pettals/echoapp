# Echo Design System Reference

Echo uses a custom React/CSS design system for a focused macOS-first desktop dictation utility. The target feel is calm, native, and operational: SF Pro typography, neutral system-like surfaces, top-leading layouts, restrained motion, clear keyboard access, and accent color reserved for active dictation and primary confirmation.

## Direction

- Dark mode remains the default for new configs, but light mode is equally polished.
- The UI is neutral-first. Use black, white, gray, and charcoal for structure; use green only for recording, progress, success, focus, and primary confirmation.
- The shell keeps Echo's left navigation plus main content layout. Do not add a music-app search bar, right activity panel, or Spotify branding.
- Prefer flat, readable surfaces over decorative glass. Native macOS backdrop support may remain subtle, but content surfaces should not depend on translucency for legibility.
- Reserve glassmorphism for the transient floating HUD, where it behaves like a system overlay rather than a full app window.
- Screens should feel efficient: primary content starts near the top/leading edge, related controls group tightly, and empty space supports comprehension rather than drama.

## Tokens

Design tokens live in `src/App.css` under `.window-root[data-theme="dark"]` and `.window-root[data-theme="light"]`.

- Radius: `8px`, `10px`, `14px`, `18px`, `24px`, with pills for nav accents, buttons, and the indicator.
- Typography: SF Pro stack, `13px` default control/body size, `11-12px` labels, `30-34px` page titles, and heavier weights reserved for primary status.
- Surfaces: window, sidebar, content, card, raised surface, muted surface, active surface, hover surface, control surface, and player surface.
- Semantics: accent, success, warning, error, text, soft text, muted text, border, and stronger border.
- Motion: hover/focus transitions stay under `180ms`; prefer color, border, and opacity changes over lift or scale. Reduced-motion users get fades only.

## Layout

- Main shell: fixed left sidebar plus one scrollable main content area.
- Sidebar: compact brand, two primary destinations, settings in the footer, rounded active rows, and native-feeling color/border feedback.
- Dictation view: top-leading status and action, followed by one neutral command surface with state glyph, shortcut/cleanup chips, and transcript feedback.
- Setup readiness: compact chips and actionable setup rows only when blocked.
- History view: playlist-like grouped rows with timestamp/status metadata and icon actions that become fully visible on hover.
- Settings view: native grouped form rows with neutral provider choices, right-aligned controls where practical, clear labels/helper text, and sticky Save/Cancel actions.
- Indicator: polished floating glass capsule with primary action, animated waveform, timer, confirmation action, and durable error messaging.

## Theme Behavior

The user-facing appearance preference is `appearance_theme: "system" | "light" | "dark"` in `AppConfig`. New/default configs use `"dark"`. Existing saved configs keep their stored preference, and missing fields continue to deserialize through serde defaults.

React resolves `"system"` with `prefers-color-scheme` and applies the concrete theme through `data-theme="light"` or `data-theme="dark"` on each Tauri window root.

## Platform Behavior

- Native macOS keeps transparent window/vibrancy plumbing only as a subtle platform enhancement. App content uses neutral fills so text remains readable over any desktop.
- Native macOS vibrancy fills the full window bounds; do not add an extra material corner radius that can expose dark transparent cut-outs at the app corners.
- Windows keeps best-effort Mica as enhancement only. CSS neutral surfaces must carry the actual app readability.
- Browser preview should look complete without native window materials.

## Component Rules

- Use primitives from `src/components/ui.tsx` before adding one-off controls.
- Primary buttons use green fills; secondary buttons use neutral control surfaces.
- Hover states matter, but they should stay quiet: nav rows, provider choices, icon buttons, segmented controls, and setup/history rows respond with surface, border, or text changes.
- Use segmented controls for exclusive appearance choices and toggles for binary settings.
- Prefer icon buttons for repeated row actions such as copy/delete.
- Keep first-run and error states actionable with one clear next step.
- Preserve clipboard-copy fallback messaging when Accessibility paste automation is unavailable.
- Keep macOS menu commands in sync with primary flows: Start/Stop Dictation, Dictate, History, Settings, Check Setup, Hide, and Quit.

## Avoid

- Reintroducing MUI or Emotion for core app UI.
- One-off color values outside the token system unless a semantic token is missing.
- Heavy glass, decorative gradients, nested cards, brand-copying Spotify, or oversized nonfunctional artwork.
- UI that only works in dark mode: light/system remain user-selectable and must stay legible.
