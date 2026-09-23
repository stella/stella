---
"@stll/cli": patch
---

Capabilities that create or change documents now require `stella:documents_write`, the consent the named document tools already required: `entities.upload`, `entities.upload-version`, `entities.bilingual.create`, `entities.create-from-legal-source`, `entities.restore-version`, `document-translations.runs.create`, and `fields.kanban-placement.update`. `entities.duplicate` and `entities.copy-to-matter` require it in addition to `stella:matters_write`. Document uploads through `uploads.create` and `uploads.update` require it too, and `stella upload` checks for both scopes before starting a new document.
