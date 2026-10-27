---
"@stll/ui": patch
---

`ScrollArea` sizes its viewport with flex instead of a percentage height, so an area inside a column bounded only by a max-height scrolls within it instead of growing past it.
