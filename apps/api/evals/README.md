# Evals

Model-in-the-loop checks of Stella's AI surfaces. An eval hands a model the
production tool definitions and prompts, then scores what comes back with
deterministic code, so a prompt or tool-contract change can be judged on
what models actually do rather than on intuition.

Evals live next to the API because they import the same tool definitions
the chat registers. They call paid models, so they run on demand, never in
CI, and they resolve models from the instance credentials in `.env`.

## Running

```sh
cd apps/api
bun run eval:create-document
bun run eval:create-document -- --models claude-haiku-4-5-20251001,openrouter::google/gemini-2.5-flash --runs 3
bun run eval:create-document -- --task en-nda --json /tmp/out.json --sources-dir /tmp/sources
```

Model ids take the `provider::modelId` form or a bare id resolved through
the default provider chain (see `getTanStackTextModelById`).

## Conventions

- One file per eval, named after the surface it measures.
- Prompts are fixed and multilingual; the scoring is code, not a judge
  model, so a regression is reproducible.
- Print a Markdown table per model plus a one-line summary; `--json` keeps
  the full record (including the raw model output) for offline analysis.
- Keep results out of the repository.

## Evals

- `create-document-drafting.ts`: can a model write legal source the
  docx-core compiler accepts, how much does the compiler normalize, and does
  literal markdown leak into the document?
- `suggest-changes-precision.ts`: given a DOCX and an edit request, does a
  model change exactly what was asked (no collateral edits), guard its
  operations with block hashes, and do the reviewer's skips match its intent?
- `template-fill.ts`: can a model fill a DOCX template through the
  `fill_template` contract: correct field paths and types, ISO and locale
  date handling, and asking rather than inventing a missing required value?
- `template-authoring.ts`: the other half of the template contract; can a
  model turn a source document into a template through `save_template`:
  the right `{{markers}}` in the right paragraphs, a `fields` overlay that
  configures each one, and no grammar trap (unprefixed item paths, `this.`,
  bracket indexing, per-language path variants, inline block markers)?
- `extraction.ts`: does the structured-extraction path (`generateWorkflowData`)
  match ground truth across text, date, int, and select fields, and does it
  answer a question the source never states?
- `agent-orientation.ts`: given stella's MCP tool list or CLI skill, does a
  model pick the right tool or command and arguments for a natural-language
  task, scored without executing anything?
