---
"@stll/cli": patch
---

Ship every capability's full input schema. Three view capabilities previously exceeded the export byte cap and shipped with no schema at all, so `views.create`, `views.update` and `view-templates.create` had no typed flags and no local `--input` validation; schemas are now `$defs`-compacted instead of dropped, and the generated route map shrinks from 4.47 MB to 1.66 MB.
