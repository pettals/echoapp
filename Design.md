# Echo Design System Reference

Echo uses a small custom React/CSS design system. The target feel is calm, native, and Perplexity-inspired: clean light surfaces by default, a polished dark mode, restrained controls, compact navigation, and a floating HUD that feels like a quiet macOS utility.

## Direction

- Light mode is the default visual language: warm off-white content, soft gray sidebar, black/charcoal text, subtle borders, and low shadows.
- Dark mode mirrors the same layout with near-black surfaces, neutral contrast, and the same restrained accent behavior.
- Accent color is used sparingly for active navigation, live recording, progress, focus rings, and important status states.
- The app should feel simple and operational, not decorative: no large gradients, heavy glossy cards, or oversized marketing-style panels.

## Tokens

Design tokens live in `src/App.css` under `.window-root[data-theme="light"]` and `.window-root[data-theme="dark"]`.

- Radius: `8px`, `10px`, `14px`, `18px`, `24px`.
- Typography: SF Pro stack, no letter-spacing adjustments, medium weights over heavy weights.
- Surfaces: window, sidebar, content, card, strong surface, muted surface, and hover surface.
- Semantics: accent, success, warning, error, text, soft text, muted text, border, and stronger border.
- Motion: short fades and opacity/background changes under `180ms`; reduced motion is respected globally.

## Layout

- Main app shell: fixed left sidebar plus main content pane.
- Sidebar: compact logo, understated navigation, soft active row with a thin accent strip.
- Dictation view: centered heading plus one command surface that shows current state, shortcut, cleanup mode, transcript preview, and primary action.
- History view: dense rows in a single grouped surface, with compact metadata and quiet row actions.
- Settings view: stacked sections using the same card, field, toggle, select, segmented control, alert, chip, button, and progress primitives.
- HUD: compact floating pill with a status tile, concise text, live waveform while recording, and a small stop button.

## Theme Behavior

The user-facing appearance preference is `appearance_theme: "system" | "light" | "dark"` in `AppConfig`. Existing configs default to `"system"` through serde defaults. React resolves `"system"` with `prefers-color-scheme` and applies the concrete theme through `data-theme="light"` or `data-theme="dark"` on each Tauri window root.

## Component Rules

- Use custom primitives from `src/components/ui.tsx` before adding new one-off controls.
- Keep buttons compact and predictable: primary for the main action, secondary for neutral commands, icon buttons for simple repeated actions.
- Use segmented controls for exclusive appearance choices.
- Use toggles for binary settings.
- Use row layouts for repeated history items instead of stacked cards.
- Keep first-run and error states actionable, with a clear next step.
- Preserve clipboard fallback messaging when Accessibility paste automation is unavailable.

## Avoid

- Reintroducing MUI or Emotion for core app UI.
- One-off color values outside the token system unless a semantic token is missing.
- Heavy gradients, large glowing icons, nested cards, or decorative backgrounds.
- Styling that only works in light mode or only works in dark mode.
