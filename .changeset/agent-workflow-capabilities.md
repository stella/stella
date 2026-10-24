---
"@stll/cli": minor
---

Add `stella capability` commands for document redline suggestions (`docx-suggestions list`, `resolve`, `revert`), assistant memory (`memories list`, `create`, `update`) and notifications (`notifications list`, `read-state-update`).

Memory writes use their own consent scope; memory and redline writes require confirmation for each call.
