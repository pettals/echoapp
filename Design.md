# Echo Design System Reference

Echo uses a custom React/CSS design system for a focused macOS-first desktop dictation utility. The current target is a dark, premium dashboard language inspired by compact health/energy apps: black shell, smoked charcoal panels, orange action accents, green success, cyan-to-green progress, precise line icons, and contained glow.

## Direction

- Dark mode is the main experience and the default for new, missing, or invalid configs.
- Light mode and System remain user-selectable and must stay legible, but they are alternate modes.
- Keep Echo desktop-first: fixed left navigation, one main scrollable workspace, compact dense controls, and no mobile-tab-bar layout.
- Use black, charcoal, violet-gray, and soft white for structure; use orange for primary action/active emphasis, green for success/readiness, and cyan/green gradients for progress.
- Gradients and glow are allowed when contained inside panels, progress bars, active rows, and command surfaces. Avoid full-window rainbow decoration.
- Use translucency and blur as polish, not as a dependency for readability. Solid fallback surfaces must still work.

## Tokens

Design tokens live in `src/App.css` under `.window-root[data-theme="dark"]` and `.window-root[data-theme="light"]`.

- Radius: `8px`, `10px`, `14px`, `18px`, `24px`, with pills for nav accents, buttons, segmented controls, chips, and the indicator.
- Typography: SF Pro stack, `13px` default control/body size, `11-12px` labels, `30-34px` page titles, and heavier display weights reserved for stats/status.
- Surfaces: window, sidebar, content, card, raised surface, muted surface, active surface, hover surface, control surface, and player surface.
- Semantics: `--accent` is orange, `--success` is green, `--info` is cyan, `--progress-fill` is cyan-to-green, plus warning/error/text/border tokens.
- Motion: hover/focus transitions stay under `180ms`; prefer color, border, opacity, and subtle glow. Reduced-motion users get fades only.

## Layout

- Main shell: fixed left sidebar plus one scrollable main content area.
- Sidebar: compact brand, primary destinations, settings in the footer, and active rows with soft fill plus orange edge.
- Dictation view: top-leading status/action, stats bento dashboard, milestone toast, setup readiness, and one prominent command surface.
- Setup readiness: compact chips and actionable setup rows only when blocked; successful states use green.
- History view: grouped rows with timestamp/status metadata and icon actions that become fully visible on hover.
- Notepad view: split note list/editor workspace with active rows and editor surfaces using the same smoked panel treatment.
- Settings view: grouped form sections, icon-led headers, orange primary actions, green success/provider states, and sticky Save/Cancel actions.
- Indicator and standalone notepad are separate surfaces; keep them compatible with tokens but do not force the main-window dashboard layout onto them.

## Theme Behavior

The user-facing appearance preference is `appearance_theme: "system" | "light" | "dark"` in `AppConfig`. New/default configs use `"dark"`. Existing saved configs keep their stored preference. Missing or invalid frontend values normalize to `"dark"`.

React resolves `"system"` with `prefers-color-scheme` and applies the concrete theme through `data-theme="light"` or `data-theme="dark"` on each Tauri window root.

## Platform Behavior

- Native macOS can use transparent window/vibrancy plumbing as a subtle enhancement, but CSS surfaces carry the actual app readability.
- Native macOS vibrancy fills the full window bounds; do not add an extra material corner radius that can expose transparent cut-outs at app corners.
- Windows keeps best-effort Mica as enhancement only. The CSS token surfaces must stand alone.
- Browser preview should look complete without native window materials.

## Component Rules

- Use primitives from `src/components/ui.tsx` before adding one-off controls.
- Primary buttons use orange fills; secondary buttons use smoked neutral control surfaces.
- Success/readiness states use green; progress bars use the cyan-to-green gradient.
- Use segmented controls for exclusive appearance choices and toggles for binary settings.
- Prefer icon buttons for repeated row actions such as copy/delete.
- Keep first-run and error states actionable with one clear next step.
- Preserve clipboard-copy fallback messaging when Accessibility paste automation is unavailable.
- Keep macOS menu commands in sync with primary flows: Start/Stop Dictation, Dictate, History, Settings, Check Setup, Hide, and Quit.

## Avoid

- Reintroducing MUI or Emotion for core app UI.
- One-off color values outside the token system unless a semantic token is missing.
- Mobile-only layouts, brand-copying the reference image, nested cards, or oversized nonfunctional artwork.
- Uncontained glow that competes with content.
- UI that only works in dark mode: light/system remain user-selectable and must stay legible.
