---
"@stll/ui": minor
---

`MenuPreviewLayout` takes `previewWidth: "remaining"` for a menu whose width is set from outside: the preview takes the width the options leave and is hidden below 10rem, so it never paints past the menu. The default, `"fixed"`, keeps the fixed-width pane.
