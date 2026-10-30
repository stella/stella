---
"@stll/ui": minor
---

`DialogPopup` takes `size` (`sm` | `default` | `lg` | `xl`) for its width (a caller's own `max-w-*` still wins; below `sm` the bottom-sheet and fullscreen layouts lift it). The unsaved-changes guard now holds back every user dismissal (a click outside, a close or cancel button, Escape) once with a hint before discarding, and the hint names the gesture: `DialogLabels` gains a required `unsavedChangesClose` for pointer dismissals.
