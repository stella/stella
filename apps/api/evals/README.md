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
  literal markdown leak into the document.
