---
"@stll/cli": patch
---

`fields cell-metadata-update` accepts `overrideReason`: why a person replaced the value a run produced in a cell. It is refused with `cell_override_absent` on a cell that holds no such replacement.
