---
"@stll/cli": patch
---

`lists.verifications.get` returns `unreadParts`: the text a completed run could not read, each from a `start` to an `end` edge (a block id and an offset). No claim was looked for there; verify the document again to read it. Empty when the run read everything.
