---
"@stll/ui": patch
---

Let `InspectorDock` say where it is mounted, so a dock that a page hangs inside the content column paints above the shell's sticky top bar instead of behind it. Clamp a dragged pane width to the pane's own bounds before it is kept, so a drag past either bound is remembered as that bound rather than reset to the default on the next load.
