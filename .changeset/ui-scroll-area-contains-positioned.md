---
"@stll/ui": patch
---

A scroll area's viewport is the containing block of what is positioned inside it, so an absolutely positioned descendant, such as a visually hidden label, stays inside the scroll instead of giving an ancestor a scrollbar of its own.
