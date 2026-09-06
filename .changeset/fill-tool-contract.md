---
"@stll/cli": minor
---

`stella template save-filled` takes `--completion-mode`, the same strict-by-default policy `stella template fill` already had: a fill that leaves `{{placeholders}}` live now fails instead of writing that document into a matter. `stella template fill` takes `--output-mode` (`text` by default, `docx` for the base64 archive), so a fill no longer returns a large base64 blob unless it is asked for. `stella capability templates fill-preview` takes `values` as a JSON object through `--input` instead of a JSON-encoded string flag.
