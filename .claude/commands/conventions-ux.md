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

## Empty States & Inline Help

- An empty state earns one line, and that line is an **action**
  (the gesture that fills it), not a definition. Teach
  "Select text → right-click → Make field", not what a field is.
  Conceptual education lives in tooltips or docs, never as
  permanent panel prose.
- Full-width buttons are reserved for a surface's single primary
  action. Structural or secondary adds use quiet ghost
  affordances (small `+`, text button).
- Side-panel sections with zero items collapse to a single row
  (heading + count + add affordance) by default; they expand on
  demand or when they gain content.

## Loading States

- **Skeleton loaders must match the real layout.** The skeleton's
  dimensions, spacing, and column count should mirror the content
  it replaces so the page doesn't shift on load.
- **Inline spinners over full-page loaders.** Scope loading
  indicators to the region that's actually waiting. A full-page
  spinner for a sidebar fetch is disorienting.
- **Render the destination's structure, not a logo.** When a route
  loads, show its real shape (table chrome with header and columns,
  toolbar, section cards) with the values shimmering in. The centered
  glowing logo (`DefaultPendingComponent`) is the last-resort
  fallback, not the default. Give each route its own
  `pendingComponent` so the route you navigate to picks its own shape.
- **Skeletons must be structurally drift-proof.** Generate the
  skeleton from the same source as the real UI, never a hand-copied
  parallel tree. For tables, render the header, rows, and skeleton
  from one column model (`@stll/ui` table plus the shared
  `TableSkeletonRows` helper) so adding or reordering a column moves
  all three at once. Where the page chrome does not need the data,
  move the Suspense boundary inward (render the real chrome, suspend
  only the leaves). For scaffolds that cannot share a source, mirror
  the real layout faithfully.

## Viewport & Responsive

- **Use `min-h-dvh`, not `h-screen`.** `h-screen` ignores the
  mobile browser chrome and causes scroll/overlap bugs. `dvh`
  units adapt to the dynamic viewport.

## Hit Areas

- All interactive elements must have a minimum 44×44px touch
  target (WCAG 2.5.8). If the visible element is smaller, extend
  the hit area with a pseudo-element or padding.

## Right-to-Left (RTL) & Bidirectional

Stella ships an Arabic (RTL) UI; every surface must mirror correctly
and stay locale-aware. Test new UI in `ar` (not just `en`) before
shipping — flipping `documentElement.dir` is not enough on its own.

- **Logical properties only.** Use `ps-/pe-`, `ms-/me-`, `start-/end-`,
  `border-s/-e`, `text-start/-end` — never physical `pl-/pr-`, `ml-/mr-`,
  `left-/right-`, `text-left/right`, `border-l/-r`, `rounded-l/-r`.
  Physical directional classes do not flip under `dir="rtl"`. Enforced by
  the `no-physical-properties` oxlint rule.
- **Mirror direction, not identity.** Render directional glyphs (chevrons,
  arrows, back/forward, next/prev, breadcrumb separators, pagination, drawer
  toggles) through `<DirectionalIcon icon={...} />` (`@stll/ui`), which
  centralizes the `rtl:-scale-x-100` mirror. Do NOT mirror brand marks/logos,
  the media play triangle, checkmarks, or anything whose meaning is
  orientation-free. For disclosure chevrons that `rotate-90` on expand, pass
  `flip={!isExpanded}` so the mirror applies only while collapsed — an
  always-on mirror composes with the rotation and points the expanded state
  the wrong way.
- **Format through the central locale.** Route all numbers, dates, and
  relative times through `useFormatter()`/`getFormatter()` (or pass
  `getFormattingLocale()`); never a bare `Intl.*` / `.toLocale*String()`
  with the base `lang` or no locale — that drops the user's numbering-system
  preference (e.g. Eastern Arabic-Indic digits). Enforced by the
  `no-raw-locale-format` oxlint rule.
- **Isolate embedded Latin & numerals.** Wrap Latin runs inside RTL text
  (case numbers, ECLI, citations, file names, emails) in `<bdi>` so bidi
  reordering doesn't scramble neighbouring punctuation. Use `dir="auto"` on
  free-text user inputs; keep `tel`/`email`/`url` and code fields LTR.
- **Panels mirror as a unit.** A panel on the inline-end in LTR (right)
  docks to the inline-start in RTL (left); its internal rail + content keep
  their relative order automatically via flex + logical props — never pin
  with physical `right-0`/`left-0`.
- **Document surfaces stay LTR-based.** The editor/document canvas (folio)
  keeps an LTR base direction even under an RTL UI; only the app chrome
  mirrors. Brand wordmark/logo is never mirrored or transliterated.
- **No untranslated LTR islands.** Don't leave English strings (suggested
  prompts, labels, empty-state copy) inside an otherwise-Arabic surface;
  route them through i18n. A Latin island reads as "unfinished," not "global."

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
