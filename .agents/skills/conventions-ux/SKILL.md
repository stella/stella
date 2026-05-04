---
name: conventions-ux
description: 'Apply when building or modifying user-facing UI components.'
---

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

## Icon Semantics

- Use the magic wand icon for AI text rewrite/refine/redraft
  actions, including search query refinement and prompt editing.
  Do not use generic sparkles for this function.

## Reduce Visual Noise

- Secondary information (counts, metadata) subtle by default.
  Use opacity transitions to reveal details on hover.
- Don't compete for attention; let the content speak.
