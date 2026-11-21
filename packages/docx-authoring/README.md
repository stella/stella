# @stll/docx-authoring

stella-styled Word documents from Markdown, a document model or a transcript, for the API and the desktop.

## What lives here

- `./document`: the empty house document (styles, numbering, fonts, A4 geometry) and its serialisation to DOCX bytes.
- `./markdown`: Markdown composed into the house document, the entry point for model-written prose.
- `./transcript`: a recording's transcript with the time each paragraph starts, and its cleaned-up text with the dictation's instructions noted above it.

Everything runs in Bun and in a browser, so the API and the desktop window produce the same documents. The tests pin the house styles and the transcript layouts.

## What does not

Drafts in the legal-source markup, AI edits to an existing document and template buffers stay in the API's `lib/docx-authoring`, which has no browser consumer. Filing a document in a matter stays with the API.

## License

Apache-2.0
