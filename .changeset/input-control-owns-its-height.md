---
"@stll/ui": patch
---

Let the control wrapper own an `Input`'s height. The element no longer states a height of its own at any size: it fills the control and keeps its line box as a `min-h-*` floor, so a height passed in `className` reaches the text and the caret instead of leaving them at the top of a taller box while the search icon centres on it.
