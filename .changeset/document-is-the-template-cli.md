---
"@stll/cli": patch
---

The capability catalog follows the template surface: `templates.manifest` (embed a field manifest into an uploaded DOCX) is gone, and `templates.create`, `templates.save-document` and `templates.update` no longer take a `manifest` argument. A template's fields are what its markers declare.
