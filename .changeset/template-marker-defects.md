---
"@stll/template-conditions": minor
---

`classifyMarkerDefect` names the authoring mistake behind a `{{...}}` span the grammar rejects — `unknown_directive` for a `{{#...}}` / `{{/...}}` token that is not a directive, `bracket_index` for `{{items[0].name}}` — and `MARKER_DEFECT_KINDS` lists those kinds so a consumer can derive its own codes from them instead of repeating the list. A span `classifyMarker` accepts is never a defect, so the directive grammar stays the only authority on which tokens exist.
