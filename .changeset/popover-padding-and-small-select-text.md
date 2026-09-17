---
"@stll/ui": minor
"@stll/workspace-ui": patch
---

`PopoverPopup` takes a `padding` prop (`none`, `xs`, `sm`, `md`, `default`) for its viewport instead of callers reaching into the `popover-viewport` slot. `SelectTrigger size="sm"` and `Button size="sm"` render small text themselves. Theme tokens `shadow-floating` and `shadow-floating-ring` replace inline shadow recipes.
