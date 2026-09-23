---
"@stll/cli": patch
---

Capabilities that create or change documents now require `stella:documents_write`, the consent the named document tools already required: `entities.upload`, `entities.upload-version`, `entities.bilingual.create`, `entities.create-from-legal-source`, `entities.duplicate`, `entities.copy-to-matter`, `entities.restore-version`, and `fields.kanban-placement.update`. Document uploads through `uploads.create` and `uploads.update` require it too.
