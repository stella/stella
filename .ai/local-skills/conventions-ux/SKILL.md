---
name: conventions-ux
description: "Apply when building or modifying user-facing UI components."
---

# UX Conventions

Apply when building or modifying user-facing UI components.

## Brand & Visual Identity

Keywords: **crystal-clear, subtle, detail-oriented, high-precision.**
Visual inspiration: glass-like surfaces. Clean, translucent, precise.

Default palette: clean neutral grays on white. Accent palettes
(Nord, Flexoki) available as user preferences; brand stays
monochrome with the Stella symbol (`StellaMark` from
`@stll/ui/stella-mark`). Never substitute a letter or a section-sign glyph
for the symbol; static markup uses the official
`apps/landing/public/brand/stella-symbol.svg` asset.

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
  colours. Competing accents create visual noise. [review]
- **No pure `#000000` backgrounds** in the app chrome. Use the
  `--background` token (neutral-950 blend in dark mode) so
  surfaces retain subtle warmth and depth. [review]
- **Saturation ceiling:** accents should stay under 80% saturation
  in oklch. Neon, oversaturated gradients, and glowing outer
  shadows are off-limits; they read as consumer/gaming, not
  professional. [review]

## Core Beliefs

Users notice the little things. Every interaction should feel smooth, good UX
is invisible, and minimum clutter keeps users in the flow.

## Micro-interactions

Small, almost invisible touches. Linear is a good reference. Number and count
changes get a subtle fade (~200ms), never a slot-machine animation. State
transitions (loading, success, error) should feel continuous, not jarring; when
in doubt, simpler is better, or skip it.

## Icon Semantics

- A skill or saved prompt is `SkillIcon` (the open book) everywhere it
  appears: menus, composer chip, sent message, landing. [review]
- `AiActionIcon` (the magic wand) is for AI actions: rewrite, refine,
  redraft, search query refinement, prompt editing, AI rename. Do not
  use generic sparkles for this function, and never for a skill. [review]

## Review chrome

Review-like surfaces (document review, playbook findings, AI
suggestions, skill proposals, version history, comments) render
their status badges, severity dots, accept/reject controls,
comment cards, out-of-date notices and diff text through
`@stll/ui/review-*`. Do not mint a local chip class map, a local
`<ins>`/`<del>` style, or a bespoke accept/reject button pair: map
the surface's vocabulary onto `ReviewStatusTone` /
`ReviewSeverityLevel` with a total `as const satisfies
Record<...>` map and pass it in.

## Editors

Two editors, two jobs, and they never swap:

- **Document model → Folio.** Anything that is a document (`.docx`,
  drafts, templates, redlines, tracked changes) is edited in Folio. [review]
- **Source text → the hybrid markdown editor.** Skills, prompts and
  knowledge files are plain source; they are edited in the hybrid
  markdown editor. [review]

Never route one through the other: a document forced through the
markdown editor loses its formatting model, and source text forced
through Folio gains one it does not have.

## Reduce Visual Noise

Keep secondary information (counts, metadata) subtle by default and reveal
details on hover with an opacity transition. Don't compete for attention; let
the content speak.

## Typography Polish

The base stylesheet applies `-webkit-font-smoothing: antialiased` globally for
crisper macOS text on light backgrounds. Numbers that change in place
(counters, timers, numeric table columns) use
`font-variant-numeric: tabular-nums` so the layout does not shift; headings and
short blocks use `text-wrap: balance`, body text `text-wrap: pretty`.

## Surfaces & Depth

Nested rounded elements are concentric: outer radius = inner radius + the
padding between them. Depth comes from layered semi-transparent `box-shadow`;
`border` marks semantic boundaries (inputs, dividers). Images on light
backgrounds get a subtle `outline: 1px solid rgb(0 0 0 / 0.06)` edge.

## Interactions & Animations

- **Interruptible animations:** use CSS `transition` for
  interactive state changes (hover, press) so the browser can
  interrupt mid-animation. Reserve `@keyframes` for staged
  sequences (page load, modals). [review]
- **Frequency decides whether it animates.** What people repeat many
  times a day (keyboard shortcuts, command palette open/close, list
  keyboard navigation) gets no animation; occasional surfaces (dialogs,
  sheets, toasts) get the standard one. [review]
- **Tooltips open instantly once one is open:** the app-level
  `TooltipProvider` groups them; do not mount another provider. [review]
- **Pressable controls give feedback on press.** The shared `Button`
  already scales slightly while enabled; do not add per-call-site
  press effects. [review]

A list or grid that appears (page load, filter change) may cascade its items
with a small stagger (30–60ms per item, capped at ~8 items). Icons in circles,
play triangles and other asymmetric glyphs are aligned optically, not
geometrically.

## Control States

- **Every control answers every state:** hover, pressed, focus-visible,
  disabled and, where it loads, pending. A press with no visible
  response reads as a missed click. [review]
- **Show where people are.** The current item in navigation and
  breadcrumbs is styled as current and carries `aria-current`. A tab
  shows its selected state through `aria-selected`, which
  `@stll/ui/tabs` supplies; never add `aria-current` to it. [review]
- **A dialog only when the work has to stop.** A small edit happens
  inline; a side task that needs the page behind it opens in a
  `@stll/ui/sheet`. [review]
- **Hidden means out of reach.** Content hidden from everyone
  (a collapsed panel, an inactive rail) leaves the tab order (`inert`,
  `hidden`, or unmounted); `aria-hidden` alone still lets focus land
  inside. The control that reveals it stays reachable, keeps an
  accessible name, and reports `aria-expanded`. A control that is
  visually hidden until focus reveals it (a skip link, the data
  table's keyboard row action) stays in the tab order by design. [review]

Confirm a destructive action with `@stll/ui/destructive-confirm-dialog`, report
an outcome with `@stll/ui/toast`, and put a field error next to the field.

## Lists, Settings Pages & Search

- **Inventories of named things are grouped lists, not tables.**
  Connections, sessions, keys, integrations: use `@stll/ui/list`. A
  `ListGroup` has a header (title + `ListGroupCount` + one quiet line +
  an optional quiet trailing action) over one `List` surface of
  hairline-divided rows. Row anatomy: 32px `ListItemMedia` tile, a
  truncating title, one clamped secondary line, then trailing status or
  actions. Use a `Table` only when people compare values across columns
  (sorting, numbers, dates side by side). [review]
- **Nothing scrolls sideways.** Free text (descriptions, scope lists,
  notes) never sits in a `whitespace-nowrap` cell or row. Clamp it
  (`line-clamp-1`/`-2` with `min-w-0` on the column), and collapse a
  long list into a count that opens a popover ("15 permissions"). The
  trailing actions stay on screen at every width. [review]
- **Status is a dot plus a label** (`ListItemStatus` with a tone). The
  label carries the meaning; colour is never the only signal. [review]
- **Anything people look up by name gets search.** Use
  `@stll/ui/search-field`: an instant local filter, case- and
  accent-insensitive, and Escape clears it. While a query is active,
  hide setup and help content, show match counts in the group headers,
  and when nothing matches, show one line plus the next action. [review]
- **Show things where people look for them.** When an entity is managed
  elsewhere but people expect it on another page (integrations live in
  Tools, yet people look for them under Connections), list it there too
  as a read-mostly row that links to its one source of truth. Don't copy
  the management UI. [review]
- **Write for a lawyer who has never heard of MCP.** The first path names
  the tools people already use (Claude, ChatGPT) and asks for at most one
  thing to copy. Protocol names, server variants, CLI commands and developer
  tools (Cursor, Codex) live behind a folded "Developer access" section,
  never in the default view. [review]
- **Setup steps have one source.** Product copy, onboarding and copied agent
  instructions point to the same guide (one docs page, one shared component
  such as `AssistantSetup`); they never carry their own step lists that can
  drift. [review]
- **One-time setup is rows with copy buttons**, placed below the live
  state: server URLs, CLI commands, keys. No stacks of paragraphs and
  read-only inputs. Copy confirms in place (the icon turns into a check).
  [review]

## Empty States & Inline Help

- An empty state earns one line, and that line is an **action**
  (the gesture that fills it), not a definition. Teach
  "Select text → right-click → Make field", not what a field is.
  Conceptual education lives in tooltips or docs, never as
  permanent panel prose. [review]
- Full-width buttons are reserved for a surface's single primary
  action. Structural or secondary adds use quiet ghost
  affordances (small `+`, text button). [review]
- Side-panel sections with zero items collapse to a single row
  (heading + count + add affordance) by default; they expand on
  demand or when they gain content. [review]

## Loading States

- **Skeleton loaders must match the real layout.** The skeleton's
  dimensions, spacing, and column count should mirror the content
  it replaces so the page doesn't shift on load. [review]
- **Inline spinners over full-page loaders.** Scope loading
  indicators to the region that's actually waiting. A full-page
  spinner for a sidebar fetch is disorienting. [review]
- **Render the destination's structure, not a logo.** When a route
  loads, show its real shape (table chrome with header and columns,
  toolbar, section cards) with the values shimmering in. The centered
  glowing logo (`DefaultPendingComponent`) is the last-resort
  fallback, not the default. Give each route its own
  `pendingComponent` so the route you navigate to picks its own shape.
  [review]
- **Shimmer only what you do not know yet.** Chrome that needs no data
  (the logo, primary nav icons, rail toggles, fixed icons) renders for real
  in a skeleton, taken from the same definitions the real chrome uses; only
  data- or locale-dependent parts (labels, lists, the account, the page
  body) shimmer. A grey box where the stella logo belongs reads as broken.
  [review]
- **Skeletons must be structurally drift-proof.** Generate the
  skeleton from the same source as the real UI, never a hand-copied
  parallel tree. For tables, render the header, rows, and skeleton
  from one column model (`@stll/ui` table plus the shared
  `TableSkeletonRows` helper) so adding or reordering a column moves
  all three at once. Where the page chrome does not need the data,
  move the Suspense boundary inward (render the real chrome, suspend
  only the leaves). For scaffolds that cannot share a source, mirror
  the real layout faithfully. [review]

## Mobile

- A surface fixed to a screen edge pads that edge with the
  `--safe-area-*` properties (`@stll/ui` `lib/safe-area.ts`); shared
  sheets, dialogs, toasts and the shell already do. [review]
- A new interactive primitive gets `select-none` and its own pressed
  state; never `select-none` on text people may copy. [review]

## Hit Areas

- Stella targets a minimum 44×44 CSS-pixel touch area for interactive
  controls. If the visible element is smaller, extend its hit area without
  changing the visual size or colliding with adjacent controls. [review]
- Respect reduced-motion preferences. Meaning and completion feedback must not
  depend on animation, hover, colour alone, or pointer precision. [review]

## Right-to-Left (RTL) & Bidirectional

Stella ships an Arabic (RTL) UI; every surface must mirror correctly
and stay locale-aware. Test new UI in `ar` (not just `en`) before
shipping — flipping `documentElement.dir` is not enough on its own.

- **Mirror direction, not identity.** Render directional glyphs (chevrons,
  arrows, back/forward, next/prev, breadcrumb separators, pagination, drawer
  toggles) through `<DirectionalIcon icon={...} />` (`@stll/ui`), which
  centralizes the `rtl:-scale-x-100` mirror. Do NOT mirror brand marks/logos,
  the media play triangle, checkmarks, or anything whose meaning is
  orientation-free. For disclosure chevrons that `rotate-90` on expand, pass
  `flip={!isExpanded}` so the mirror applies only while collapsed — an
  always-on mirror composes with the rotation and points the expanded state
  the wrong way. [review]
- **Isolate embedded Latin & numerals.** Wrap Latin runs inside RTL text
  (case numbers, ECLI, citations, file names, emails) in `<bdi>` so bidi
  reordering doesn't scramble neighbouring punctuation; keep `tel`/`email`/`url`
  and code fields LTR. [review]
- **Document surfaces stay LTR-based.** The editor/document canvas (folio)
  keeps an LTR base direction even under an RTL UI; only the app chrome
  mirrors. Brand wordmark/logo is never mirrored or transliterated.
  [review]

## Look at the Render

Lint and tests prove nothing banned was written; they say nothing
about whether the screen is good. Before calling UI done, capture it
with `bun run agent:drive` (see the `dev` skill): `snap <route>` at
the default desktop size and again with `--viewport 390x844`, then a
`run` flow that switches to `ar`. Judge the screenshots,
not the code: you wrote the code, so you read your intentions into it.
A problem visible in a screenshot is real whatever the code says.

Make each pass on its own:

1. **One second.** Glance and look away. You should have seen one
   thing: the content the screen exists for. "A page" means nothing
   leads.
2. **Squint.** Text blurs into grey bars. The screen should reduce to
   a few masses of clearly different weight, not many equal ones.
3. **Edges.** Count the distinct left (inline-start) edges of text
   blocks. Two or three, reused, is composed; more means things were
   placed one at a time.
4. **Space.** Related things sit close, unrelated things far. Any
   empty region is either deliberate or a hole beside a short column
   or a removed element.
5. **Accent.** Name where the accent appears. On the primary action
   and perhaps one other thing it means "here"; in ten places it means
   nothing.
6. **States.** Empty, loading, error, long content and many items:
   each one shot, each one designed (see Empty States, Loading States).
7. **Collisions.** Nothing overlaps text or a control, nothing is
   clipped, nothing scrolls sideways, at either width or direction.

Write the findings down the way a designer would tell a colleague:
"the row's secondary line starts 8px left of its title", not "could
be more polished". Fix in this order, because later items cannot
rescue earlier ones: hierarchy (one dominant thing per region),
composition (edges, spacing, holes), typography, colour, detail
(states, focus, alignment), motion. Re-shoot and look again; stop
after three rounds and say plainly what still falls short.

## Anti-Patterns

Keep narrative prose below 80 characters per line through the Prose component; code, tables, editors and other task-shaped surfaces are exempt.

Explicit list of patterns that AI agents tend to generate and
that do not belong in a professional legal workspace. Each began as a
reasonable idea and became a tell by being produced by default,
without a reason.

Removing a tell is half the job. A screen stripped of ornament with
nothing in its place reads as unfinished; fill the space with the
content itself (larger, complete, specific), not with another
ornament.

- **No emojis in the product UI.** Use Lucide icons or semantic
  status colours instead. [review]
- **No "AI aesthetic" chrome:** purple/blue neon glows, pulsing
  gradient borders, holographic effects. Stella's AI features
  should feel like native tools, not a tech demo. [review]
- **No centred hero sections** in application views. Heroes
  belong on marketing pages; app screens use content-first
  layouts. [review]
- **No generic three-equal-cards grids.** If content genuinely
  comes in threes, fine; but don't default to `grid-cols-3` as
  the go-to layout. Prefer asymmetric grids, two-column splits,
  or list views that match the data shape. [review]
- **No filler copy.** Never use "Lorem ipsum", "John Doe",
  "Acme Corp", "99.99%", or similar placeholder text in
  committed UI. Use realistic legal-domain examples (matter
  names, party names, deadlines) or leave the slot empty with
  a proper empty state. [review]
- **No AI copywriting clichés:** "Elevate", "Seamless",
  "Unleash", "Revolutionize", "Supercharge". Write plain,
  specific microcopy. [review]
- **No generic copy shapes.** No "not just X, it's Y"; no "Get
  started" or "Learn more" labels (name what the button does); no
  exclamation marks in success messages; no "Oops!" errors (say what
  failed and what to do next); English headings and labels use
  sentence case, not Title Case, and each translation follows its
  own locale's capitalization. [review]
- **No decorative scroll indicators** (bouncing chevrons,
  "Scroll to explore" text). If content scrolls, the scrollbar
  is sufficient affordance. [review]
- **No custom cursors or pointer overrides** beyond the standard
  `pointer` for interactive elements. [review]
