# UX Conventions

Apply when building or modifying user-facing UI components.

## Brand & Visual Identity

Keywords: **crystal-clear, subtle, detail-oriented, high-precision.**
Visual inspiration: glass-like surfaces. Clean, translucent, precise.

Default palette: clean neutral grays on white. Accent palettes
(Nord, Flexoki) available as user preferences; brand stays
monochrome with the Stella § mark.

Brand colours (reference, not for hard-coding):

| Name        | Hex       | Usage                          |
| ----------- | --------- | ------------------------------ |
| Black       | `#000`    | Primary text, logo mark        |
| Soft Blue   | `#cae1fb` | Illustration/accent background |
| Pale Blue   | `#e2f6fd` | Light tint surfaces            |
| Blue Accent | `#59a1d4` | Accent in marketing material   |

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

## Typography Polish

- `-webkit-font-smoothing: antialiased` on macOS for crisper
  text on light backgrounds. Apply globally in the base stylesheet.
- `font-variant-numeric: tabular-nums` on any element whose
  number changes dynamically (counters, timers, tables with
  numeric columns). Prevents layout shift.
- `text-wrap: balance` on headings and short text blocks to
  distribute lines evenly. `text-wrap: pretty` on body/paragraph
  text to avoid orphans.

## Surfaces & Depth

- **Concentric border radius:** when nesting rounded elements,
  outer radius = inner radius + padding between them. Hard-coding
  both to the same value produces a visual mismatch.
- **Shadows over borders:** prefer layered semi-transparent
  `box-shadow` for depth and separation. Reserve `border` for
  semantic boundaries (inputs, dividers), not for creating depth.
- **Image outlines:** for images on white/light backgrounds, add a
  subtle `outline: 1px solid rgb(0 0 0 / 0.06)` to define the edge
  without a heavy border.

## Interactions & Animations

- **Never use `transition: all`.** Always specify exact properties
  (e.g., `transition: opacity 150ms, transform 150ms`). `all`
  triggers unnecessary repaints and can animate properties you
  didn't intend.
- **Interruptible animations:** use CSS `transition` for
  interactive state changes (hover, press) so the browser can
  interrupt mid-animation. Reserve `@keyframes` for staged
  sequences (page load, modals).
- **Optical alignment over geometric:** icons inside circles,
  play-button triangles, and asymmetric glyphs should be nudged
  visually until they *look* centred, even if that means offset
  from the geometric centre.

## Hit Areas

- All interactive elements must have a minimum 44×44px touch
  target (WCAG 2.5.8). If the visible element is smaller, extend
  the hit area with a pseudo-element or padding.
