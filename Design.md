# Echo Design System

This is the current visual and interaction reference for Echo, the Tauri 2 desktop dictation app. It is an implementation-facing description of the design already present in the repository, not a speculative redesign.

## Source of truth

- `src/App.css` — global tokens, themes, window layout, shared primitives, auth/onboarding, Dictate, History, Notepad, and responsive rules.
- `src/components/ui.tsx` — shared React primitives: buttons, icon buttons, cards, chips, alerts, notices, disclosures, settings groups/rows, fields, toggles, segmented controls, progress, and animated icon swaps.
- `src/App.tsx` — screen composition, states, customer-facing copy, navigation, onboarding, Dictate, History, Notepad, standalone Notepad, and HUD routing.
- `src/components/Settings.tsx` and `src/components/Settings.css` — Settings information architecture and its tabbed/grouped presentation.
- `src/components/AudioHudIndicator.css` — the separate always-on-top Dynamic Island/HUD visual system.
- `src/components/AnimatedOrb.css` — the expressive orb used in preview/visual moments; it is not the workspace surface language.
- `src/components/AureoleIcons.tsx` — the shared line-icon set.
- `src/assets/` and `src-tauri/icons/` — product marks, tray icon, app icon, and supporting visual assets.
- `PRD.md` — product behavior and terminology contract.

`design2.md` is an older translucent/music-dashboard direction. It should not be treated as current: the production UI uses an opaque, compact workspace with a persistent branded sidebar, no right context column, and no search-first navigation.

## Product character

Echo should feel like a calm, focused desktop utility: fast to understand, quiet while idle, expressive only when recording or celebrating a meaningful milestone. The core emotional promise is low-friction speech-to-text, so visual hierarchy always favors the next dictation action and its current state.

The design language is:

- compact and desktop-first, with dense but breathable grouped content;
- native-feeling through system typography, restrained motion, clear focus, and platform-aware copy;
- graphite/cool-neutral in the workspace, with purple-pink brand color contained in navigation, focus, progress, and feedback;
- state-led rather than decoration-led: listening, processing, pasted, copied, warning, and error are explicit;
- resilient without native blur, vibrancy, Mica, or transparency; those materials may enhance a platform build but must not be required for legibility.

## Window and shell

The primary app fills the Tauri window. `.app-shell` is a two-column grid:

```text
┌────────────────────┬──────────────────────────────────────┐
│ Echo brand         │                                      │
│ Dictate            │        one scrollable workspace       │
│ Notepad            │        page heading + grouped UI      │
│ History            │                                      │
│                    │                                      │
│ Settings           │                                      │
└────────────────────┴──────────────────────────────────────┘
       196px                         flexible content
```

- Sidebar: fixed `196px` column, full height, branded gradient, `54px 14px 16px` padding.
- Main content: flexible, full-height, clipped shell with scrolling delegated to the content column.
- Workspace width: Dictate, History, and Settings are centered to approximately `880px`; Settings may extend to `960px`.
- Outer shell: square and opaque (`border-radius: 0`); do not reintroduce rounded transparent outer corners.
- Dragging: window drag regions are separate from interactive controls. Icon buttons and controls opt out of drag with `data-no-window-drag`.
- Standalone Notepad and the HUD are separate Tauri window roots. Workspace tokens must never leak into the HUD.

## Color and theme tokens

Tokens live in `src/App.css`. Use tokens rather than one-off color literals.

### Brand anchors

| Token | Current value | Role |
| --- | --- | --- |
| `--brand-purple` | `#7C5CFF` | Echo mark and brand family |
| `--brand-magenta` | `#C81D8E` | Brand depth and emphasis |
| `--brand-coral` | `#FF7A72` | Warm edge of the brand gradient |
| `--brand-gradient` | purple → magenta → coral | Sidebar/contained decorative brand use |

### Default shared dark theme

| Token | Current value | Role |
| --- | --- | --- |
| `--bg` | `#0F1727` | page background |
| `--bg-soft` | `#141E31` | secondary shell/sidebar base |
| `--surface` | `#19243A` | grouped surfaces and cards |
| `--surface-2` | `#202D46` | controls and raised/inset surfaces |
| `--surface-hover` | `#2A3955` | hover and selected lift |
| `--border` | `#31415E` | strong separators/focus support |
| `--border-soft` | `#263550` | subtle row dividers |
| `--text-1` | `#F7F8FF` | primary text |
| `--text-2` | `#B8C1D6` | supporting text |
| `--text-3` | `#7E8BA7` | muted metadata |
| `--accent` | `#C81D8E` | primary interactive accent |
| `--accent-strong` | `#F064C5` | accent text/highlight |
| `--accent-purple` | `#8B72FF` | purple accent bridge |

### Semantic colors

| Token | Current value | Meaning |
| --- | --- | --- |
| `--success` | `#48D99A` | completed, pasted, healthy |
| `--info` | `#A394FF` | processing or informational |
| `--warning` | `#F2B75E` | needs attention |
| `--error` | `#FF7382` | failed or destructive |

Each semantic color has a soft variant for contained backgrounds. Semantic color must communicate meaning; it should not be used as general decoration.

### Light theme

The `data-theme="light"` root maps the same semantic roles to cool off-whites, graphite text, purple accents, and darker semantic colors. The workspace becomes light, but the signed-in sidebar keeps its dark purple-pink brand gradient. `system` resolves to light or dark using `prefers-color-scheme`; missing or invalid values normalize to dark.

### HUD palette

The HUD is intentionally independent and uses black, white, muted blue-gray, green, red, and a purple accent. Its own `--hud-*` variables in `AudioHudIndicator.css` are the source of truth. Do not restyle it with workspace card or sidebar rules.

## Typography

Use platform system fonts with no remote dependency:

```css
--display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
--body: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
--mono: ui-monospace, "SFMono-Regular", "Cascadia Code", "Segoe UI Mono", monospace;
```

| Role | Size/weight | Use |
| --- | --- | --- |
| Page heading | `clamp(30px, 4vw, 32px)` in workspace; up to `44px` in shared fallback | primary screen title |
| Dictate state | `20px / 650` | Ready, Listening, Transcribing, etc. |
| Group heading | `15px / 660` | Settings groups and card titles |
| Body/control | `13px / 500–650` | labels, buttons, descriptions |
| Small copy | `12px` | helper text and supporting descriptions |
| Label/meta | `11px` | uppercase context labels, status metadata |
| Numeric metric | body size + `tabular-nums` | WPM, word counts, milestones, durations |

Use `text-wrap: balance` for headings and `text-wrap: pretty` for body/help copy. Keep line lengths short in cards and sidebars. Use weight and opacity to create hierarchy before introducing another hue.

## Spacing, radius, and elevation

- Controls use an `8px` radius (`--radius-s`).
- Groups and cards use `14px` (`--radius-m`).
- Pills, status chips, keycaps, toggles, and icon buttons use `999px` where the shape is semantically compact or circular.
- Standard page rhythm is `14px–20px` between related blocks; grouped rows use `12px 16px` padding and a minimum `56px` height.
- Form controls are designed around a consistent `46px` height.
- Ordinary surfaces use tonal contrast and dividers, not heavy shadows.
- Elevation is reserved for dialogs, menus, temporary toasts, and overlays. If a shadow is needed, use a layered token rather than a hard black outline.
- Nested rounded elements should be concentric: the outer radius is larger than the inner radius by the surrounding padding.

## Navigation and sidebar

The sidebar is the strongest persistent brand surface.

- Header: Echo tray mark at `34px` plus the Echo wordmark; a compact Pro badge may sit alongside it.
- Navigation: one line icon plus label, `40px` row height, `10px` horizontal padding, `4px` row gap.
- Inactive: white at reduced opacity.
- Hover: translucent white lift.
- Active: translucent white fill, subtle inset border, full white label/icon, slightly heavier weight.
- Footer: Settings is pinned below a faint divider.
- Icons: shared line icons, visually aligned and optically centered; do not introduce decorative icons into every section.

## Shared controls

Use primitives from `src/components/ui.tsx` before adding a bespoke control.

- `Button`: primary, secondary, outline, ghost, and danger variants; compact desktop sizes; icon is optional and placed before the label.
- `IconButton`: repeated copy/delete/refresh/close actions; always has an accessible label and title.
- `Field` / `SelectField`: visible labels, helper text, tokenized inset surface, purple focus ring, error state.
- `Toggle`: boolean settings with a clear text label.
- `SegmentedControl`: exclusive choices such as Appearance or Cloud/On-device; active selector slides between items.
- `Chip`: compact neutral/accent/semantic metadata.
- `Alert` / `InlineNotice`: actionable status messaging, with optional progressive disclosure for details.
- `Disclosure`: native `<details>` pattern with a rotating chevron; use for secondary insight and diagnostics rather than showing everything at once.
- `Progress`: determinate and indeterminate states; use for model download/setup and processing feedback.

Interactive targets should be at least `40×40px`, including icon-only actions. Focus-visible states must remain visible in both themes. Never use `transition: all`; specify the properties being animated.

## Screen designs

### Authentication and first run

Authentication and onboarding use a dark Echo brand presentation. The first-run shell is split between a large visual/brand region and a focused form region. It supports Google sign-in, email/password sign-up and login, email verification, password recovery, and actionable errors.

Onboarding is a three-step flow:

1. Check microphone, shortcut, and paste readiness.
2. Configure provider/model and Groq API key when applicable.
3. Test the shortcut and complete setup.

Each step has a clear next action, compact status rows, and a way to skip/reopen setup when appropriate. On macOS, Accessibility guidance is explicit; on Windows, use customer-facing “Paste readiness” language. Clipboard fallback must always be communicated when auto-paste is unavailable.

### Dictate home

Home is task-first and intentionally does not require a Start button. The global shortcut is the primary action.

- Page heading establishes Dictate as the current destination.
- The main `.dictate-hero` presents the current state: Ready, Listening, Transcribing, Pasted, Copied, or an actionable error.
- State icon sits in a `44px` accent-soft square; copy is concise and left-aligned.
- Shortcut is rendered as platform-aware keycaps, never as the raw `CommandOrControl` string.
- Recording/processing may show progress, a transcript preview, or a short recording note.
- Setup troubleshooting is shown only when readiness is blocked.
- Insights are collapsed by default. Expanded values are total words, rolling WPM, day streak, and next milestone progress.
- Technical timing details live in a nested closed disclosure labeled for people who need diagnostics.
- Milestone celebrations are temporary and contained, not persistent success banners.

### History

History is a dense, scan-friendly list within a centered panel.

- Heading and clear action share the top row.
- Search is available when useful; empty and filtered-empty states explain the next step.
- Rows prioritize transcript text, timestamp, and paste/copy status.
- Copy and delete actions are icon buttons with labels; actions may become more visible on hover.
- Clear history requires a confirmation state.
- History remains local, bounded by the configured limit, and uses semantic status colors sparingly.

### Notepad

Notepad is a split workspace: note list on the left, selected editor on the right.

- Header contains title and New note.
- List supports search, active-row selection, empty state, and note metadata.
- Editor is a grouped surface with copy/delete actions, autosave status, markdown-capable text entry, and dictation insertion status.
- Empty editor state explains how to create a note.
- Standalone Notepad uses the same tokens but a simpler single-note window with its own drag zone and compact header.

### Settings

Settings is a compact tabbed system with Account, Dictation, Input, and App tabs. The hierarchy is progressive disclosure rather than a collection of nested decorative cards.

- Account: authentication, Pro entitlement, checkout/restore, and sign-out.
- Dictation: Cloud/On-device provider, models, cleanup, and local model state.
- Input: microphone device, shortcut capture, paste readiness, and platform-specific guidance.
- App: appearance, sounds, history retention, launch at login, and advanced diagnostics.
- Use `SettingsGroup` and `SettingsRow` with dividers, clear labels, and concise descriptions.
- Healthy readiness should not occupy persistent space; show an inline notice only for a failing or incomplete check.
- Save/Discard appears only when pending changes differ from saved configuration.
- Keep technical controls behind Advanced or contextual disclosure.
- Centralize Pro messaging in Account; locked features should link back to that surface instead of repeating paywall cards.

### Dynamic Island HUD

The HUD is a separate always-on-top surface, not a miniature copy of the workspace. It supports:

- idle compact pill;
- hover-expanded idle actions;
- recording with target icon, live partial transcript, and waveform;
- processing/transcribing;
- success/pasted;
- copied fallback and no-target copy review with countdown/action;
- error with a recovery message.

The HUD uses a black pill/island, compact responsive widths, semantic ambient color, and carefully bounded animation. It may use image outlines for target icons (`rgba(255,255,255,0.1)` in dark HUD context). Keep its hit areas and action labels accessible.

### Animated orb

`AnimatedOrb` is an expressive visual asset made from layered gradients, glass, rim trails, sheen, grain, and slow breathing/drift animations. It is suited to preview/brand moments and should not be added to routine workspace cards, settings rows, or the HUD unless the product direction explicitly changes.

## Motion and interaction

Motion is quiet, fast, interruptible, and state-explanatory.

- Fast transitions: `120ms`; normal: `160ms`; standard easing: `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Buttons and navigation use subtle tactile feedback; keep press scale close to `0.96` rather than exaggerated shrinkage.
- Shared icon swaps use opacity, scale `0.25 → 1`, and blur `4px → 0px`; Motion spring transitions use `duration: 0.3` and `bounce: 0`.
- `AnimatePresence` uses `initial={false}` for stateful default UI so the app does not animate unexpectedly on first render.
- Segmented-control selection animates the active selector, not the entire control.
- Panel transitions should use small opacity/vertical shifts; exits are softer than enters.
- Recording uses ambient breathing; processing uses a restrained sheen; success/error should settle quickly.
- Respect `prefers-reduced-motion`: reduce to fades or instant transitions and remove continuous decorative movement where possible.
- Avoid full-window shimmer, heavy springs on utility controls, large pulsing glows, and animation that competes with live transcript content.

## Accessibility and states

- Every icon-only control has an accessible label and title.
- Every input has a visible label; helper and error text are associated through the field pattern.
- State changes use `role="status"` or `role="alert"` where appropriate, not color alone.
- Focus-visible rings use the accent token and work against both light and dark surfaces.
- Text remains legible without blur or transparency support.
- Dynamic numbers use `font-variant-numeric: tabular-nums` to prevent layout shift.
- Headings balance naturally; body copy avoids orphaned final words with `text-wrap: pretty`.
- Destructive actions use confirmation or a clear undo/recovery path.
- Error copy names the problem and gives one next step. Raw error codes, internal phases, config filenames, and command names stay out of primary UI.

## Platform behavior

### macOS

Prioritize SF-style typography, menu bar/tray behavior, Accessibility permission guidance, focus restore, and clipboard fallback. The persistent brand sidebar remains present while the workspace stays opaque and readable.

### Windows

Keep the same layout and token language, but validate titlebar, tray, shortcut, clipboard paste, focus, and installer behavior on real Windows. Do not present macOS-only Accessibility affordances. Use “Paste readiness” and preserve copy fallback. Native Mica/transparency is optional enhancement only.

## Asset rules

- Use `app-tray-icon.png` for the in-app Echo mark where the current shell expects the tray-compatible mark.
- Use `echoNewLogo.png` and `echoNewLogoMark.png` for brand/auth/marketing contexts where the larger logo treatment is appropriate.
- Keep `groq-logo.svg` reserved for provider identity in setup/settings.
- Keep platform app/tray icons in `src-tauri/icons/`; do not substitute web assets into native packaging without checking scale and mask requirements.
- Images should use the theme-aware subtle outline token when placed on a surface: black at low opacity in light contexts and white at low opacity in dark contexts.

## Design review checklist

- [ ] The screen makes the next dictation/setup action obvious.
- [ ] Shared tokens and primitives are reused.
- [ ] The sidebar remains the persistent brand anchor.
- [ ] Workspace surfaces are opaque/readable without native blur.
- [ ] Light and dark concrete themes are both legible.
- [ ] Platform-specific shortcut and paste language is correct.
- [ ] Healthy readiness is quiet; blocked readiness is actionable.
- [ ] Dynamic numbers use tabular numerals.
- [ ] Interactive controls have at least `40×40px` hit areas.
- [ ] Focus-visible and reduced-motion states are present.
- [ ] No `transition: all`, accidental first-render animation, or unbounded decorative glow.
- [ ] HUD styles remain isolated from workspace styles.
- [ ] `PRD.md` and `TASKS.md` are updated when a production design decision changes scope or status.

