---
"@stll/ui": patch
---

`Button` turns `aria-label` or `title` into a tooltip only at an icon size; a text-size button gets one only from an explicit `tooltip`. Overlay triggers (`PopoverTrigger`, `MenuTrigger`, dialog, sheet and alert-dialog triggers and closes) no longer derive a tooltip from their own label; rendered as an icon `Button`, they hand it the label.
