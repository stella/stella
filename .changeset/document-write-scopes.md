---
"@stll/cli": patch
---

Capabilities that create or change documents now require `stella:documents_write`, the consent the named document tools already required: `entities.upload`, `entities.versions.upload`, `entities.bilingual.create`, `entities.from-legal-source.create`, `entities.versions.restore`, `document-translations.runs.create`, and `fields.kanban-placement.update`. `entities.duplicate` and `entities.copy` require it in addition to `stella:matters_write`. Document uploads through `uploads.create` and `uploads.update` require it too, and `stella upload` checks for both scopes before starting a new document.
