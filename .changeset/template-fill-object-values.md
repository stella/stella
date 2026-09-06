---
"@stll/cli": minor
---

`stella capability templates fill-to-matter` now takes `values` as a JSON object through `--input` instead of a JSON-encoded string flag, matching `fill-preview`. The stored-template fill endpoints behind them read the same object: `templates.fill-by-id`, `templates.fill-preview`, and `templates.fill-to-matter` take `values` as a field-path map in the JSON body, and the web fill form sends it that way. The multipart upload fill (`templates.fill`) keeps `values` JSON-encoded, because a multipart field carries a string.
