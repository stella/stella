# Plan: Anonymisation Corpus Test Infrastructure

Date: 2026-03-13

## Goal

Build a test infrastructure that validates the anonymisation pipeline
against a large corpus (~1000 contract fixtures) with auto-generated
baselines. Detect regressions in entity recall, precision, and
redaction correctness across pipeline changes.

## Design Decisions

- **Git submodule for fixtures**: The corpus (~1000 contracts) is
  too large for the main repo. A separate private repo
  (`stella/anonymisation-fixtures`) is added as a git submodule
  at `apps/web/src/lib/anonymize/__corpus__`. This keeps the
  main repo lightweight while making fixtures available to CI.
  Why: avoids bloating clone times for contributors who don't
  touch anonymisation; submodule is only fetched when needed.

- **Auto-generated baselines, not hand-authored**: Running the
  pipeline produces `entities.json` + `redacted.txt` per
  fixture. These are committed as baselines. When the pipeline
  changes, developers re-run generation, review the diff, and
  commit updated baselines. Why: hand-authoring ground truth
  for 1000 documents is impractical; diff-based review catches
  regressions while allowing intentional improvements.

- **Two-phase workflow (generate + assert)**: A `generate`
  script runs the offline pipeline on all fixtures and writes
  baseline files. A `test` script asserts current output matches
  baselines. CI runs only the assert phase; generation is a
  local dev step. Why: keeps CI fast and deterministic; avoids
  flaky tests from model inference differences.

- **Offline pipeline only**: Corpus tests run the non-NER parts
  of the pipeline (triggers, regex, gazetteer, false-positive
  filter, coreference). NER results are non-deterministic across
  hardware and model versions; including them would cause
  baseline churn. Why: the offline pipeline is deterministic
  and covers the majority of detection logic.

## Scope

**In scope:**

- Git submodule setup (`stella/anonymisation-fixtures`)
- Baseline generation script (`generate-baselines.ts`)
- Corpus test runner (`corpus.test.ts`) using `bun:test`
- CI workflow step: clone submodule + run corpus tests
  (only when anonymise lib files change)
- Per-fixture output: `entities.json` (sorted by offset) +
  `redacted.txt`

**Out of scope:**

- NER-based baselines (non-deterministic)
- Aggregate metrics (precision/recall/F1); future enhancement
- Fixture sourcing and curation (separate effort)
- Gazetteer fixtures (corpus tests run without gazetteer entries)

## Implementation

- `apps/web/src/lib/anonymize/__corpus__/` — git submodule
  pointing to `stella/anonymisation-fixtures`
- `apps/web/src/lib/anonymize/__corpus__/inputs/` — raw
  contract text files (`.txt`)
- `apps/web/src/lib/anonymize/__corpus__/baselines/` —
  auto-generated `{name}.entities.json` + `{name}.redacted.txt`
- `apps/web/src/lib/anonymize/corpus.test.ts` — test runner
  that iterates inputs, runs offline pipeline, asserts against
  baselines
- `apps/web/src/lib/anonymize/generate-baselines.ts` — script
  to regenerate all baselines (`bun run generate-baselines`)
- `.github/workflows/ci.yml` — add submodule checkout step
  with deploy key, conditional on anonymise path changes
- `.gitmodules` — submodule entry

## Test Cases

- Corpus test passes when baselines match pipeline output
- Corpus test fails with clear diff when output diverges
- `generate-baselines` produces deterministic output across
  runs (same input → same baseline)
- CI skips corpus tests when anonymise files are untouched
- Graceful skip when submodule is not initialised (local dev
  without the corpus)

## Open Questions

- Repository name and access: `stella/anonymisation-fixtures`
  (private) — needs deploy key for CI checkout
- Fixture format: plain `.txt` only, or include `.docx`?
  (txt-only is simpler and avoids mammoth dependency in tests)
- Baseline granularity: per-entity JSON or aggregate counts?
  (starting with per-entity for maximum regression sensitivity)
