# Stella Design System

Portable design specification for AI agents and human contributors.
This file documents the visual language of Stella's web application
so that any tool producing UI (Claude Code, Cursor, Stitch, Copilot)
generates consistent, on-brand output.

> **Canonical source of truth:** `packages/ui/src/styles/globals.css`.
> This file is a human-readable summary; when in doubt, read the CSS.

---

## 1. Visual Theme & Atmosphere

**Keywords:** crystal-clear, subtle, detail-oriented, high-precision.

Stella is a legal workspace. The aesthetic is closer to a well-typeset
legal brief than a consumer SaaS dashboard. Surfaces should feel like
frosted glass: clean, translucent, precise. Every pixel of chrome
should recede so the user's content (documents, matters, deadlines)
is the loudest thing on screen.

**Reference products:** Linear, Notion, Clio (clarity, not flash).

**What this is NOT:** dark-mode-neon, glassmorphism, "AI aesthetic"
with purple gradients, gamified, playful, or illustration-heavy.

---

## 2. Color Palette & Roles

### Semantic Tokens

All colours are consumed via CSS custom properties. Never hard-code
hex values in components; use the semantic tokens below.

| Token                  | Light                           | Dark                                  | Role                       |
| ---------------------- | ------------------------------- | ------------------------------------- | -------------------------- |
| `--background`         | white                           | neutral-950 / 95% white blend         | Page canvas                |
| `--foreground`         | neutral-800                     | neutral-100                           | Primary text               |
| `--card`               | white                           | background / 98% white blend          | Card surfaces              |
| `--card-foreground`    | neutral-800                     | neutral-100                           | Text on cards              |
| `--primary`            | neutral-800                     | neutral-100                           | Primary actions, headings  |
| `--primary-foreground` | neutral-50                      | neutral-800                           | Text on primary            |
| `--secondary`          | black / 4%                      | white / 4%                            | Secondary surfaces         |
| `--muted`              | black / 4%                      | white / 4%                            | Subdued backgrounds        |
| `--muted-foreground`   | neutral-500 / 90% black blend   | neutral-500 / 90% white blend         | Secondary text             |
| `--accent`             | black / 4%                      | white / 4%                            | Hover/focus highlights     |
| `--destructive`        | red-500                         | red-500 / 90% white blend             | Destructive actions        |
| `--info`               | blue-500                        | blue-500                              | Informational status       |
| `--success`            | emerald-500                     | emerald-500                           | Success status             |
| `--warning`            | amber-500                       | amber-500                             | Warning status             |
| `--highlight`          | yellow-300 / 50%                | yellow-500 / 20%                      | Search/text highlight      |
| `--border`             | black / 8%                      | white / 6%                            | Borders, dividers          |
| `--input`              | black / 10%                     | white / 8%                            | Input borders              |
| `--ring`               | neutral-400                     | neutral-500                           | Focus rings                |

### Sidebar Tokens

The sidebar has its own surface family (`--sidebar`, `--sidebar-foreground`,
`--sidebar-accent`, `--sidebar-border`, `--sidebar-ring`) to allow
independent treatment from the main content area.

### Accent Palettes

Users can switch between three palettes (applied via a root class):

- **Default** (neutral Tailwind grays on white)
- **Flexoki** (warm, desaturated; `.palette-flexoki`)
- **Nord** (cool, arctic; `.palette-nord`)

Both palettes provide full light/dark variants. All semantic tokens
are redefined per palette; components need no palette-specific code.

### Brand Colours (Reference)

| Name        | Hex       | Usage                          |
| ----------- | --------- | ------------------------------ |
| Black       | `#000`    | Primary text, logo mark        |
| Soft Blue   | `#cae1fb` | Illustration/accent background |
| Pale Blue   | `#e2f6fd` | Light tint surfaces            |
| Blue Accent | `#59a1d4` | Accent in marketing material   |

### Colour Discipline

- One accent colour per surface region; everything else is neutral
  or a semantic status colour.
- No pure `#000000` backgrounds in app chrome (dark mode uses a
  warm neutral-950 blend).
- Accent saturation stays under 80% oklch. No neon, no glowing
  outer shadows, no oversaturated gradients.

### Option Tag Colours

16 named swatches (`--option-red` through `--option-gray`, plus
`--option-empty`) with auto-derived `-bg` and `-fg` variants via
`color-mix()`. These adapt automatically to every palette and
dark-mode combination.

---

## 3. Typography Rules

### Font Stack

```
"DM Sans", ui-sans-serif, system-ui, sans-serif,
"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"
```

**DM Sans** is the sole brand typeface. Variable font (weight 100-900),
normal and italic styles, WOFF2 with Latin + Latin Extended coverage.
`font-display: swap` for fast first paint.

No secondary or serif typeface is used in the product. Legal document
content renders in document-specific fonts (not DM Sans).

### Typographic Conventions

| Rule                                   | Implementation                            |
| -------------------------------------- | ----------------------------------------- |
| Antialiased rendering                  | `@apply antialiased` on `<html>`          |
| Tabular numerals for dynamic values    | `font-variant-numeric: tabular-nums`      |
| Balanced headings                      | `text-wrap: balance`                      |
| Pretty body text (no orphans)          | `text-wrap: pretty` on `<body>`           |
| Font weights                           | `font-medium` (500) for controls/buttons  |

### Text Sizes (Tailwind Scale)

The app primarily uses `text-xs` through `text-xl`. Most UI text
is `text-sm`; headings step up to `text-base` or `text-lg`. The
full Tailwind type scale is available but sizes above `text-xl`
are rare outside of marketing pages.

---

## 4. Component Stylings

### Component Library

Components are built on **@base-ui/react** (v1.4.0), styled with
Tailwind CSS (v4.2.2) and composed via **class-variance-authority**
(CVA). Class merging uses the `cn()` utility (clsx + tailwind-merge).

Registered as `@coss` in `components.json` (shadcn "new-york" preset).
Icons: **lucide-react**.

### Key Components

Accordion, AlertDialog, Avatar, Breadcrumb, Button, Checkbox,
Combobox, Dialog, Field, Form, Input, InputGroup, InputOTP, Label,
Menu, Pagination, Popover, PreviewCard, ScrollArea, Select,
Separator, Sheet, Skeleton, Table, Tabs, Textarea, Toast, Tooltip.

### Component Conventions

- Use existing coss components with `className` overrides; do not
  write raw `<button>`, `<input>`, etc.
- Use semantic HTML (`<nav>`, `<main>`, `<section>`) over generic
  `<div>` with ARIA roles.
- All interactive elements require a 44x44px minimum touch target
  (WCAG 2.5.8).
- Polymorphic rendering via `useRender` from @base-ui/react;
  prop merging via `mergeProps`.

### Button Variants (CVA)

- **default:** primary foreground on primary background
- **destructive:** destructive colours
- **outline:** border + transparent background
- **secondary:** secondary surface
- **ghost:** transparent, accent on hover
- **link:** underline, no background

Sizes: `default` (h-9), `sm` (h-8), `lg` (h-10), `xl` (h-11),
`icon` (square, h-9 w-9).

---

## 5. Layout Principles

### Spacing

Tailwind 4's `--spacing()` function with the default 0.25rem
(4px) increment. Common patterns:

- Page padding: `p-4` to `p-6` (16-24px)
- Component gaps: `gap-2` to `gap-4` (8-16px)
- Button internal: `px-3` minus 1px border offset
- Section spacing: `space-y-4` to `space-y-6`

### Border Radius

Root variable: `--radius: 0.625rem` (10px).

| Usage          | Class        | Approximate |
| -------------- | ------------ | ----------- |
| Small elements | `rounded-md` | 6px         |
| Most containers| `rounded-lg` | 8px         |
| Cards, dialogs | `rounded-xl` | 12px        |
| Large dialogs  | `rounded-2xl`| 16px        |
| Circular       | `rounded-full`| -          |

**Concentric radius rule:** outer = inner + gap. Nested rounded
elements must account for the padding between them.

### Content Width

Application views are bounded by the layout shell. Content areas
typically max out at `max-w-5xl` to `max-w-7xl` depending on
context (document editor vs. table view).

### Viewport

Use `min-h-dvh`, not `h-screen`. The `dvh` unit accounts for
mobile browser chrome.

---

## 6. Motion & Interaction

### Principles

- Animations should be felt, not noticed. Linear is the reference.
- Simpler is better; when in doubt, skip it.
- GPU-only: animate `transform` and `opacity` exclusively.
  Never animate `width`, `height`, `top`, `left`, `padding`,
  or `margin`.

### Transition Defaults

| Property                  | Duration | Easing       |
| ------------------------- | -------- | ------------ |
| Interactive states (hover)| 150-200ms| `ease-out`   |
| Dialogs/popovers entry   | 150ms    | `ease-out`   |
| Skeleton pulse            | 2s loop  | `linear`     |
| Caret blink               | 1.25s    | `ease-out`   |

### Entry Animations (data-driven)

Components use `data-starting-style` / `data-ending-style`
attributes for CSS view transitions:

- **Dialog:** `scale-98` + `opacity-0` on entry (scales up)
- **Sheet:** `translate-y-8` on exit (slides down)
- **Popover:** `opacity-0` on entry (fades in)
- **Backdrop:** `opacity-0` on entry with `backdrop-blur-sm`

### Staggered Reveals

List and grid items should cascade with 30-60ms stagger delay
(capped at ~8 items). The group should read as a cohesive reveal,
not a sudden block.

### Skeleton Loading

Skeletons use an animated gradient (`skeleton` keyframe, 2s
infinite linear). The `--skeleton-highlight` variable adjusts
per theme. **Skeleton dimensions must match the real content
layout** to prevent shift on load.

---

## 7. Anti-Patterns

Patterns that do not belong in a professional legal workspace.
AI agents: treat these as hard constraints.

| Category        | Banned Pattern                                           |
| --------------- | -------------------------------------------------------- |
| Colour          | Neon/glowing outer shadows, oversaturated gradients      |
| Colour          | Pure `#000000` backgrounds in app chrome                 |
| Colour          | "AI purple/blue" aesthetic (pulsing gradient borders)    |
| Typography      | Decorative/display fonts in the product UI               |
| Layout          | Centred hero sections in application views               |
| Layout          | Default three-equal-cards grid when data doesn't warrant |
| Content         | Emojis in the product UI (use Lucide icons instead)      |
| Content         | Lorem ipsum, "John Doe", "Acme Corp", fake percentages   |
| Content         | AI copywriting clichés ("Elevate", "Seamless", "Unleash")|
| Content         | "Scroll to explore", bouncing chevrons                   |
| Motion          | `transition: all` (specify exact properties)             |
| Motion          | Animating layout properties (width, height, top, left)   |
| Motion          | Custom cursors or pointer overrides                      |
| Motion          | Flashy slot-machine number animations                    |
| Interaction     | Decorative scroll indicators                             |
| CSS             | Dynamic Tailwind class construction (`` `bg-${x}-200` ``)|
| CSS             | Raw colour hex values instead of semantic tokens         |
