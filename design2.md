# Echo Design System Reference

This document defines the target UI language for Echo as a desktop-first translucent macOS utility. It is based on the supplied reference image and is intended to be implementation-ready rather than pixel-perfect.

Focus only on the app window itself. The desktop wallpaper, dock, and surrounding macOS environment are not part of the design system.

## Visual Direction

The window uses a dark, translucent music-dashboard style with visible-through blur, smoked glass layering, compact utility density, and a restrained neon-magenta/blue accent system. It should feel native to macOS: calm, polished, softly illuminated, and premium rather than flat or purely functional.

The overall impression should be:

- Dark vibrancy instead of flat dark mode.
- A soft, smoked-glass window with rounded macOS corners.
- Clear panel separation through tonal contrast, not heavy outlines.
- Compact desktop-native spacing and control sizes.
- Soft white text hierarchy with cool gray metadata.
- Small, precise accent colour for active states, selection, progress, and primary emphasis.
- Minimal line icons, discreet status dots, and muted controls.
- Occasional contained gradients inside hero/media cards, not across the whole app.

Echo should read as a refined utility window, not a mobile screen enlarged for desktop.

## Window Materials

### App Window

The outer shell should feel like a dark translucent window floating over whatever sits behind it.

- Base tone: near-black charcoal with a subtle plum undertone.
- Transparency: high enough that background light subtly influences the window, but never enough to reduce legibility.
- Border: thin, low-contrast, cool-white edge.
- Shadow: soft and broad, with no harsh glow.
- Blur: medium-to-strong, used to imply macOS vibrancy.
- Corners: large, rounded desktop-window radius.

Use this as the primary window recipe:

```css
background: rgba(18, 18, 22, 0.86);
border: 1px solid rgba(255, 255, 255, 0.08);
border-radius: 22px;
box-shadow:
  0 28px 70px rgba(0, 0, 0, 0.42),
  inset 0 1px 0 rgba(255, 255, 255, 0.05);
backdrop-filter: blur(30px) saturate(1.18);
-webkit-backdrop-filter: blur(30px) saturate(1.18);
```

### Sidebar Material

The sidebar should be darker and denser than the main content area so navigation feels anchored.

```css
background: rgba(25, 17, 27, 0.78);
border-right: 1px solid rgba(255, 255, 255, 0.05);
backdrop-filter: blur(26px) saturate(1.12);
-webkit-backdrop-filter: blur(26px) saturate(1.12);
```

### Content Surface

The main pane should be slightly lighter than the sidebar while remaining in the same translucent family.

```css
background: rgba(20, 20, 24, 0.66);
border: 1px solid rgba(255, 255, 255, 0.04);
box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
backdrop-filter: blur(24px) saturate(1.08);
-webkit-backdrop-filter: blur(24px) saturate(1.08);
```

### Card And Row Surface

Cards and grouped rows should sit on slightly lighter translucent surfaces, with subtle tonal contrast rather than obvious elevation.

```css
background: rgba(36, 34, 42, 0.58);
border: 1px solid rgba(255, 255, 255, 0.06);
box-shadow:
  inset 0 1px 0 rgba(255, 255, 255, 0.04),
  0 10px 24px rgba(0, 0, 0, 0.16);
backdrop-filter: blur(18px);
-webkit-backdrop-filter: blur(18px);
```

## Color Palette

| Token | Value | Usage |
| --- | --- | --- |
| `--window-base` | `rgba(18, 18, 22, 0.86)` | Primary app shell. |
| `--window-sidebar` | `rgba(25, 17, 27, 0.78)` | Left navigation rail. |
| `--window-content` | `rgba(20, 20, 24, 0.66)` | Main pane background. |
| `--surface-card` | `rgba(36, 34, 42, 0.58)` | Cards, panels, grouped list blocks. |
| `--surface-hover` | `rgba(54, 50, 62, 0.64)` | Hover and active surface lift. |
| `--surface-selected` | `rgba(76, 125, 255, 0.18)` | Selected rows or active pills. |
| `--border-soft` | `rgba(255, 255, 255, 0.07)` | Primary separators and panel outlines. |
| `--border-faint` | `rgba(255, 255, 255, 0.045)` | Subtle row dividers. |
| `--text-primary` | `rgba(248, 247, 252, 0.96)` | Main headings and labels. |
| `--text-secondary` | `rgba(218, 215, 226, 0.72)` | Supporting copy and control labels. |
| `--text-muted` | `rgba(166, 161, 178, 0.56)` | Metadata and inactive text. |
| `--accent-blue` | `#4C7DFF` | Active states, progress, secondary emphasis. |
| `--accent-magenta` | `#F02BC6` | Hero gradients and small highlight moments. |
| `--accent-purple` | `#8F5CFF` | Gradient bridges and decorative media surfaces. |
| `--accent-green` | `#33D17A` | Active sidebar indicator and success state. |
| `--accent-soft` | `rgba(143, 92, 255, 0.22)` | Button fills and selected-state backgrounds. |
| `--status-green` | `#41D17D` | Updated/success dots. |
| `--status-blue` | `#4C7DFF` | Update-available or active state dots. |
| `--status-orange` | `#FFB454` | Warning states. |
| `--status-red` | `#FF6A6A` | Error/destructive states. |

Use accent colour sparingly. Most of the interface should remain neutral and dark, with magenta, purple, and blue reserved for hero cards, progress bars, active states, and small primary emphasis.

## Typography

Typography should feel consistent with modern macOS utility apps.

```css
font-family: "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif;
letter-spacing: 0;
```

| Style | Size | Weight | Line Height | Usage |
| --- | --- | --- | --- | --- |
| Window title | `18px-22px` | `600-650` | `1.2` | Section titles such as “Trending” or “All Recordings”. |
| Hero title | `28px-34px` | `700` | `1.05-1.15` | Large feature card headings. |
| Toolbar label | `12px-13px` | `500-550` | `1.2` | Top nav labels, inline controls. |
| Sidebar item | `12px-13px` | `500-600` | `1.25` | Navigation rows. |
| Card title | `14px-16px` | `600` | `1.3` | App, file, recording, or card names. |
| Body copy | `12px-13px` | `400-500` | `1.45-1.55` | Supporting descriptions. |
| Button label | `12px-13px` | `550-650` | `1` | Compact pill buttons. |
| Status/meta | `11px-12px` | `450-550` | `1.2` | Status dots, timestamps, small notes. |

Rules:

- Prefer medium weights over large weight jumps.
- Use large type only for a single hero or primary page heading.
- Keep line lengths short in cards and sidebars.
- Use opacity shifts for hierarchy before changing color hue.
- Use muted labels above major titles to create the same “Top / Trending” rhythm as the reference.

## Layout

The app should be organized as a translucent desktop utility window with five major zones:

1. Traffic-light/titlebar band.
2. Sidebar navigation rail.
3. Main content area with page heading and focus card.
4. Dense list/table area beneath the focus card.
5. Right-side context column for secondary panels, profile, and playback/detail cards.

### Window Frame

- Use rounded outer corners around `20px-24px`.
- Keep a visible titlebar band at the top, with macOS traffic lights inset from the top-left.
- The top region should feel integrated into the window, not like a separate banner.
- Width should feel desktop-first, with a wide central content area and a narrower right utility column.

### Sidebar

- Width: approximately `160px-190px`.
- Content should stack as grouped navigation lists with small section labels.
- Active row should use a thin vertical accent indicator or very soft translucent fill.
- Icons should align left with tight spacing and minimal decoration.
- The brand mark should sit at the top-left, with search underneath.

### Main Content

- Horizontal padding: `24px-32px`.
- Vertical spacing: `18px-28px`.
- Use a compact page heading, then a large contained focus/hero card.
- Follow with dense rows for recordings, files, or recent activity.
- Use separators and text hierarchy rather than large card gaps.

### Right Context Column

- Width: approximately `220px-280px`.
- Place profile/account controls at the top.
- Use stacked secondary panels beneath, such as recent items, recommendations, detail cards, or playback controls.
- Cards should remain compact and aligned to the main content rhythm.

## Core Components

### Sidebar Navigation

- Row height: `30px-36px`.
- Radius: `8px-10px`.
- Default state: transparent or nearly transparent.
- Hover state: slightly lighter smoked surface.
- Active state: thin green or blue vertical marker with brighter text.
- Section labels: muted, uppercase optional, compact, and understated.

### Search Field

- Use a compact rounded input integrated into the sidebar or top toolbar.
- Height: `30px-34px`.
- Background: translucent dark fill, slightly denser than surrounding chrome.
- Include a small leading search icon.
- Placeholder should be low-contrast and not visually compete with navigation.

### Hero Banner Card

The hero card should be the most expressive element in the interface.

- Large rounded promotional/focus card.
- Radius: `16px-20px`.
- Use contained gradients, blurred colour fields, or media artwork.
- Keep surrounding interface dark and restrained.
- Text and CTA should sit over the image but remain readable through stronger local contrast.

Suggested hero gradient:

```css
background:
  radial-gradient(circle at 75% 25%, rgba(240, 43, 198, 0.95), transparent 35%),
  radial-gradient(circle at 48% 30%, rgba(143, 92, 255, 0.82), transparent 36%),
  radial-gradient(circle at 72% 75%, rgba(76, 125, 255, 0.75), transparent 44%),
  linear-gradient(135deg, #15151b 0%, #24233a 45%, #0f1015 100%);
```

### Dense Data Rows

Treat primary lists as dense grouped rows inside a single transparent table region.

- Row height: `44px-56px`.
- Each row should support icon/thumbnail, title, metadata, duration/status, optional like/favourite, and overflow menu.
- Separate rows with faint dividers rather than card gaps.
- Use muted metadata and bright primary labels.
- Keep action icons small and quiet.

### Secondary Cards

- Use compact cards in the right context column or lower grid.
- Card radius: `14px-18px`.
- Keep cards readable, with a clear title, short metadata, and one small action.
- Surfaces should be lightly translucent with subtle internal highlights.

### Playback / Detail Card

For Echo, this can translate into a recording playback, transcript preview, or selected-item detail card.

- Place it in the right column or as a bottom panel.
- Use an artwork/preview area above controls.
- Keep controls circular, compact, and evenly spaced.
- Progress bars should be thin, clean, and low contrast except for the filled portion.

```css
.progress-track {
  height: 3px;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 999px;
}

.progress-fill {
  height: 3px;
  background: rgba(255, 255, 255, 0.82);
  border-radius: 999px;
}
```

### Buttons

- Prefer compact pill or rounded-rect controls.
- Height: `28px-34px`.
- Primary actions can use white fill on dark surfaces, as seen in the reference.
- Secondary actions use dark translucent fills with subtle borders.
- Text should remain crisp and centered, with minimal padding.

```css
.primary-button {
  background: rgba(255, 255, 255, 0.94);
  color: rgba(12, 12, 14, 0.95);
  border-radius: 999px;
  height: 32px;
  padding: 0 18px;
}

.secondary-button {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(248, 247, 252, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 999px;
  height: 32px;
  padding: 0 18px;
}
```

### Status Dots

- Diameter: `6px-8px`.
- Use only for semantic change, such as updated, available, warning, error, or live recording.
- Pair them with compact text labels; do not use dots alone where meaning matters.

### Avatar And Utility Icons

- Keep utility icons small and evenly spaced in the top-right cluster.
- Avatar can be circular with a soft border or restrained glow.
- Notification badges should be tiny and precise.
- Account labels should use a primary name and muted secondary role/status.

## Motion

Motion should feel quiet and native.

- Use quick fades and short vertical shifts for panel transitions.
- Use opacity changes for navigation state switching.
- Use subtle surface lift on hover, not scale-heavy motion.
- Keep row and button interactions under `180ms`.
- Use motion to clarify focus and selection, not to decorate.

Suggested timing:

```css
--duration-fast: 120ms;
--duration-normal: 180ms;
--easing-standard: cubic-bezier(0.2, 0.8, 0.2, 1);
```

Avoid:

- Large pulsing glows.
- Floating-orb animation language.
- Heavy spring motion on utility controls.
- Excessive background shimmer.
- Full-window gradients that overpower the utility interface.

## Platform Guidance

### macOS

- This visual system should feel closest to macOS vibrancy and utility-app density.
- Prefer SF Pro text proportions, restrained separators, and integrated titlebar behavior.
- The window should appear as though it is borrowing atmosphere from the desktop behind it.
- Keep toolbar, sidebar, and content surfaces visually related, not split into unrelated themes.

### Windows

- Windows can follow the same structural layout, but should simplify the vibrancy feel if needed.
- Preserve denser utility layout and component sizing, while allowing less transparency and a clearer selected-state strip if Fluent alignment requires it.

## Implementation Checklist

- Build the window around dark translucent materials rather than a branded full-screen gradient.
- Keep the sidebar darker than the main content pane.
- Use blur, low-contrast borders, and soft shadows to separate surfaces.
- Reserve magenta, purple, blue, and green accents for contained emphasis only.
- Use a large expressive hero/focus card, but keep the surrounding UI quiet.
- Keep typography compact, desktop-first, and SF-style.
- Use grouped rows instead of large stacked cards for dense operational content.
- Prefer inline navigation and subtle active indicators over large mobile-style chips.
- Use small semantic status dots with matching text labels.
- Keep buttons short, compact, and utility-focused.
- Include a right-side context column for secondary panels and selected-item detail.
- Avoid oversized decorative graphics, glowing orbs, bottom mobile toolbars, and note-app decorative elements.
