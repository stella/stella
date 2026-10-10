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
  model turn a source document into a template through `create_template` and
  `configure_template_fields`: the right `{{markers}}` in the right
  paragraphs, one configuration entry per field, and no grammar trap
  (unprefixed item paths, `this.`, bracket indexing, per-language path
  variants, inline block markers)? Scores the four steps separately.
- `playbook-authoring.ts`: can a model drive `save_playbook` from its schema
  and description alone: the tier ladder, `extract` versus `graded`, severity
  values, `source_id` to change a position and its absence to add one, sending
  only what changed, and recovering from a duplicate-issue refusal and a stale
  `expected_updated_at`? Calls run through the production tool pipeline over an
  in-memory store. Run a small model beside a large one. Its behavior tier
  (`--tier behavior`) activates the shipped `playbook-builder` skill and
  answers `ask-user` from a script: does the model ask side, governing law,
  and language before drafting, search only matters the user named, read only
  the contracts the user confirmed, ask only where the contracts disagree,
  set `scope.perspective` only for a side that maps to one, and never resend
  an unchanged position? A scenario's follow-up messages run as later turns
  over the conversation so far, so a user who declines contracts and asks for
  their matters mid-flow is scored too. Each scenario runs on two surfaces
  (`--surface mcp|chat`): the matter reads as direct MCP tools, and as the
  chat surface, where they are `external_*` functions inside the real
  `execute_typescript` and `discover_tools` tools, the reads the skill's
  frontmatter documents are stubbed up front as chat stubs them, the
  fixtures sit behind the production registry runner, and `spawn_subagents`
  is offered under chat's delegation rule unless the skill's frontmatter
  excludes it, as the shipped skill does. Both surfaces offer
  `list_templates` as production does, answered with an empty library. A read
  rejected at the boundary, a failed script, a chat read the skill did not
  document written before `discover_tools` named it, work handed to
  subagents, or a search for starter playbooks is a defect. So is a saved
  text that names a source: every string of the stored playbook is searched,
  case-insensitively, for the fixtures' document names (with and without the
  extension), counterparties, matter names, and matter references, and the
  defect reports the field and the name. A position's `sources` may cite only
  documents the user picked; a run that read picked contracts records at
  least one, and a scenario with nothing to pick (no contracts, or attached
  ones, which have no document id) stores none. On the chat surface the
  playbook read and the save run through chat's ref mediation, so a source is
  a document ref there and an id on the MCP surface. The
  behavior tier is a pass criterion on `gpt-5.6-luna` and `gpt-6-sol`;
  `gpt-5.4-mini` stays in the default set to track the floor, not to gate.
- `extraction.ts`: does the structured-extraction path (`generateWorkflowData`)
  match ground truth across text, date, int, and select fields, and does it
  answer a question the source never states?
- `agent-orientation.ts`: given stella's MCP tool list or CLI skill, does a
  model pick the right tool or command and arguments for a natural-language
  task, scored without executing anything?

## Explain citations through local harnesses

`reader-explain-local.ts` covers ten public decision selections with cited and
citing precedent. The recorded Schrems II fixture establishes the source
paragraphs and the publisher paragraph numbers it cites in Schrems I. Actual
corpus ids, AST paragraph ids, excerpts and citator edges must be captured from
the admitted case-law reader before running these cases. No paragraph ids are
inferred from publisher paragraph numbers. The Schrems I capture is not in the
recorded seed; missing or ambiguous capture data fails before evaluation.

Keep captures, prompts and results outside the repository. A capture contains
`decisions: [{decisionId, ecli, paragraphs: [{paragraphId, publisherParagraph,
text}]}]` and `edges: [{citingDecisionId, citedDecisionId}]`; use actual corpus
reads for both. `paragraphId` is the reader’s stable `block.anchorId`, not the
internal `block.id`; `publisherParagraph` is the court’s printed paragraph
number and only locates the captured anchor. From `apps/api`:

```sh
bun run eval:reader-explain prompts /absolute/path/corpus-capture.json > /absolute/path/prompts.jsonl
bun run eval:reader-explain score /absolute/path/corpus-capture.json /absolute/path/local-results.jsonl <tracePath-from-prompts>
```

Run each emitted prompt through a local coding-agent harness, making the
emitted `fetch_related_decision_excerpts.command` available as a local shell
operation. The `tool` mode replays at most eight captured related paragraphs;
prompts include bounded context from the selected decision.
Each prompt invocation creates a unique `runId` and an empty trace at the emitted
`tracePath`; all prompts in that invocation share them. Record each result as
JSONL with that `runId`, `caseId`, `harness` (a nonempty local run label), `answer`,
`citations: [{decisionId, paragraphId}]`. The tool command appends its actual
returned citations to a local trace; scoring reads this trace separately from
model output and accepts only entries matching the result's run and case.
The tool preserves each excerpt's cited or citing direction and prioritizes the
case direction and expected paragraph before applying its bound.
The runner never imports a provider or calls a model API; it emits local
harness inputs and scores captured outputs. It requires exactly one result per
case and rejects invented or unreturned citations. The content and the expected
legal distinction are emitted together for separate review; citation success
alone does not certify the explanation. These evaluations are operator runs,
not CI model calls.
