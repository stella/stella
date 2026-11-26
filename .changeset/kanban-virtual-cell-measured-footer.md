---
"@stll/ui": patch
---

`KanbanVirtualCell` measures its pinned action with `useLayoutMeasurement` instead of writing the height from its own layout effect. Rows still rest under the action from the first paint, and the reach drops to zero when the action closes the cell. No entrypoint changes.
