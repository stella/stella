# @stll/markdown-editor

The hybrid Markdown source editor the web app and the desktop share: the raw
Markdown string is the document, the blocks around the caret show their syntax
and every other block renders formatted.

## What lives here

- `MarkdownHybridEditor` (`.`): a lazy wrapper, so no route or window loads the
  editor engine, KaTeX or the EditContext polyfill until it shows an editor.
- The implementation (`./impl`), for tests that render it without suspense.
- The stylesheet that maps the engine's theme onto the design tokens, and the
  tests that pin the engine behaviour this package relies on.

The engine is patched in the repository root (`patches/`); the width-class test
covers that patch. The package is private for the same reason: an npm consumer
would get the unpatched engine.

## What does not

What only a host can decide comes in as props: the editor's accessible label,
how a link opens (or that links do not open), and which image sources may load.
Persistence, unsaved-work guards and domain rules (skill frontmatter, workspace
files) stay in the host too.

## License

Apache-2.0
