# @stll/template-packs

Bundled document-template packs: a typed manifest over the content repository
mounted as a git submodule at `content/`, and a loader that serves a pack's
DOCX bytes by `(packId, slug)` with a content hash.

## Layout

```text
content/                      git submodule (stella/template-packs)
  index.json                  generated upstream: per-template fields + sha256
  packs/<id>/pack.json        pack metadata (validated by src/schema.ts)
  packs/<id>/templates/<slug>/template.docx
  packs/<id>/templates/<slug>/README.md
src/schema.ts                 content contract (valibot) + generated entry types
src/packs.gen.ts              generated manifest over content/
src/catalogue.ts              loader: list, get, getTemplate, readTemplateDocx
src/fixtures/                 committed test content + its generated manifest
```

## Commands

- `bun run generate` rewrites `src/packs.gen.ts` and `src/fixtures/packs.gen.ts`.
  It needs the submodule; without it the manifest is left alone.
- `bun run test` fails when either generated manifest is stale, then runs the
  loader tests.

The manifest is committed data and carries no file imports, so this package
imports cleanly in a checkout without the submodule. The loader resolves DOCX
bytes against a content root and serves an empty catalogue when that root has
no `packs/` directory, which is what a checkout without the submodule gets.
The API passes the root: the submodule mount in a source tree, and the
directory `apps/api/Dockerfile` copies into the image (`TEMPLATE_PACKS_CONTENT_DIR`).

To refresh content: update the submodule, run `bun run generate`, commit both.
