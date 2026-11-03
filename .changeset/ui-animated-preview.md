---
"@stll/ui": minor
---

Add `AnimatedPreview` (`@stll/ui/animated-preview`): a frame of ordered stages that cross-fade into each other once or in a loop, nestable inside a stage, with `AnimatedPreviewMotion` for a carry gesture and `AnimatedPreviewCard` for a hover and focus preview that describes its trigger. Reduced motion shows the final stage statically; the styles ship through `@stll/ui/theme.css`, and `@stll/ui/use-prefers-reduced-motion` exports the preference hook.
