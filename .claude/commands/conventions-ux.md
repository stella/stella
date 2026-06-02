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

### Colour Discipline

- **One accent per surface.** A screen region gets at most one
  saturated accent; everything else is neutral or semantic status
  colours. Competing accents create visual noise.
- **No pure `#000000` backgrounds** in the app chrome. Use the
  `--background` token (neutral-950 blend in dark mode) so
  surfaces retain subtle warmth and depth.
- **Saturation ceiling:** accents should stay under 80% saturation
  in oklch. Neon, oversaturated gradients, and glowing outer
  shadows are off-limits; they read as consumer/gaming, not
  professional.

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

## Icon Semantics

- Use the magic wand icon for AI text rewrite/refine/redraft
  actions, including search query refinement and prompt editing.
  Do not use generic sparkles for this function.

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
- **GPU-friendly properties only.** Animate `transform` and
  `opacity` exclusively. Never animate `width`, `height`, `top`,
  `left`, `padding`, or `margin`; these trigger layout recalc.
  Use `scale`/`translate` instead.
- **Interruptible animations:** use CSS `transition` for
  interactive state changes (hover, press) so the browser can
  interrupt mid-animation. Reserve `@keyframes` for staged
  sequences (page load, modals).
- **Staggered list entry:** when a list or grid appears (page load,
  filter change), cascade items with a small stagger delay
  (30–60ms per item, capped at ~8 items) so the group reads as a
  cohesive reveal rather than a sudden block.
- **Optical alignment over geometric:** icons inside circles,
  play-button triangles, and asymmetric glyphs should be nudged
  visually until they *look* centred, even if that means offset
  from the geometric centre.

## Loading States

- **Skeleton loaders must match the real layout.** The skeleton's
  dimensions, spacing, and column count should mirror the content
  it replaces so the page doesn't shift on load.
- **Inline spinners over full-page loaders.** Scope loading
  indicators to the region that's actually waiting. A full-page
  spinner for a sidebar fetch is disorienting.

## Viewport & Responsive

- **Use `min-h-dvh`, not `h-screen`.** `h-screen` ignores the
  mobile browser chrome and causes scroll/overlap bugs. `dvh`
  units adapt to the dynamic viewport.

## Hit Areas

- All interactive elements must have a minimum 44×44px touch
  target (WCAG 2.5.8). If the visible element is smaller, extend
  the hit area with a pseudo-element or padding.

## Anti-Patterns

Explicit list of patterns that AI agents tend to generate and
that do not belong in a professional legal workspace:

- **No emojis in the product UI.** Use Lucide icons or semantic
  status colours instead.
- **No "AI aesthetic" chrome:** purple/blue neon glows, pulsing
  gradient borders, holographic effects. Stella's AI features
  should feel like native tools, not a tech demo.
- **No centred hero sections** in application views. Heroes
  belong on marketing pages; app screens use content-first
  layouts.
- **No generic three-equal-cards grids.** If content genuinely
  comes in threes, fine; but don't default to `grid-cols-3` as
  the go-to layout. Prefer asymmetric grids, two-column splits,
  or list views that match the data shape.
- **No filler copy.** Never use "Lorem ipsum", "John Doe",
  "Acme Corp", "99.99%", or similar placeholder text in
  committed UI. Use realistic legal-domain examples (matter
  names, party names, deadlines) or leave the slot empty with
  a proper empty state.
- **No AI copywriting clichés:** "Elevate", "Seamless",
  "Unleash", "Revolutionize", "Supercharge". Write plain,
  specific microcopy.
- **No decorative scroll indicators** (bouncing chevrons,
  "Scroll to explore" text). If content scrolls, the scrollbar
  is sufficient affordance.
- **No custom cursors or pointer overrides** beyond the standard
  `pointer` for interactive elements.
