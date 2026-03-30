# UX Conventions

Apply when building or modifying user-facing UI components.

## Brand & Visual Identity

Keywords: **crystal-clear, subtle, detail-oriented, high-precision.**
Visual inspiration: glass-like surfaces. Clean, translucent, precise.

Default palette: clean neutral grays on white. Accent palettes
(Nord, Flexoki) available as user preferences; brand stays
monochrome with the Stella § mark.

Brand colours (reference, not for hard-coding; sourced from
Figma file `cW4MdTWa3w82lfTbzQXidu`):

| Name        | Hex       | Usage                          |
| ----------- | --------- | ------------------------------ |
| Black       | `#000000` | Primary text, logo mark        |
| Soft Blue   | `#cbe1fc` | Illustration/accent background |
| Pale Blue   | `#e3f6fe` | Light tint surfaces            |
| Blue Accent | `#59a1d4` | Favicon bg, brand accent       |
| Green       | `#3fa674` | Positive indicators, checks    |
| Muted       | `#a4a4a4` | Secondary/caption text         |
| Border      | `#d6d6d6` | Dividers, subtle borders       |

Brand gradient (used in marketing, banners, backgrounds):
`#59a1d4` (20%) → `#bcd1f3` (57%) → `#e3f6fe` (100%)

### Typography

| Context              | Font             | Notes            |
| -------------------- | ---------------- | ---------------- |
| Product UI           | DM Sans          | Variable, 100-900|
| Logo wordmark        | Cabinet Grotesk  | Medium (w500)    |

Cabinet Grotesk is variable; web fonts are in the designer
deliverables (`font/CabinetGrotesk_Complete/Fonts/WEB/`).

### Glass effect

Frosted-glass overlays: white at 5% opacity with
`backdrop-blur`. Matches the "crystal-clear, translucent"
brand direction. Shadows are subtle and warm-toned
(e.g., `rgba(237,232,232,0.5)`).

Use semantic tokens (`bg-muted`, `text-foreground`, `border`)
rather than raw colour values.

## Core Beliefs

- Users notice the little things
- Every interaction should feel smooth
- Good UX is invisible; it just works
- Minimum clutter; keep users in the flow

## Micro-interactions

Small, almost invisible touches. Linear is a good reference.

- Number/count transitions: subtle fade (~200ms). No flashy
  slot-machine animations.
- State transitions (loading, success, error) should feel
  continuous, not jarring.
- When in doubt, simpler is better, or skip it.

## Reduce Visual Noise

- Secondary information (counts, metadata) subtle by default.
  Use opacity transitions to reveal details on hover.
- Don't compete for attention; let the content speak.
