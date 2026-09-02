---
"@stll/ui": patch
---

`InspectorDock` keeps the permanent rail on the pane's inline-start edge, the
same order as the workspace inspector panel. Collapsed, the rail is still the
whole dock on the viewport edge; expanded, the pane now opens beyond the rail
instead of between the content and the rail, so the rail's tabs and toggle
stay beside the content they describe.
