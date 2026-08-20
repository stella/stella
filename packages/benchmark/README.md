# @stll/anonymize-benchmark

Reproducible evaluation of `@stll/anonymize` (stella) and other open-source PII
redaction libraries. Independently published held-out corpora retain their
different task semantics rather than being flattened into one score.

The project-authored synthetic legal fixture (en/cs/de) and declared TAB
development split exist for regression and harness development. Its scores are
not necessarily representative.

The package also has a separate evaluation-only track based on the pinned
test split of the third-party Text Anonymization Benchmark (TAB). TAB contains
real English ECHR decisions with human direct/quasi-identifier annotations. Its
test data is never used for detector development or tuning.

## Layout

```text
fixtures/                 public-safe synthetic ground truth, per language (en/cs/de)
python/                   Python adapter scripts and pinned requirements
results/                  date-stamped reports (+ development-latest.md for the synthetic fixture)
vendor/                   pinned third-party benchmark detector assets and licenses
src/
  taxonomy.ts             common 8-label taxonomy + per-library mapping tables
  ground-truth.ts         segment -> labelled document loader (offsets by construction)
  metrics.ts              span-overlap matching + precision/recall/F1
  report.ts               Markdown report renderer
  adhoc.ts                unseen-document mode: side-by-side detections, no gold
  bench.ts                runner: bun run bench:compare [--input <file|dir>]
  adapters/               stella, OpenRedaction, Python libraries, redact-pii, PII-Shield, Nym
REPRODUCING.md            exact versions, models, hardware, mapping decisions
```

## Running

```sh
# from repo root, once:
bun install && bun run build

# from packages/benchmark, set up the Python competitors (see REPRODUCING.md):
uv venv .venv-presidio  --python 3.11 && uv pip install --python .venv-presidio  -r python/requirements-presidio.lock   # + model wheels
uv venv .venv-scrubadub --python 3.11 && uv pip install --python .venv-scrubadub -r python/requirements-scrubadub.lock
uv venv .venv-datafog   --python 3.11 && uv pip install --python .venv-datafog   -r python/requirements-datafog.lock

# run:
bun run bench:compare

# Aggregate-only held-out evaluation over a deterministic 12-document TAB sample.
# Add --full for the entire 127-document test split.
bun run bench:blind

# Run every executable held-out public corpus.
bun run bench:sealed

# Or run one complete public test split.
bun run bench:sealed:tab
bun run bench:sealed:redactionbench
bun run bench:sealed:meddocan
bun run bench:sealed:german-ler

# German LER with the optional pinned Nym ONNX assistance lane.
bun run bench:sealed:german-ler:assisted

# Development-only five-document TAB comparison (aggregate by default).
bun run bench:dev-gap
```

`bench:blind` verifies the upstream file against a pinned SHA-256 digest before
loading it and writes only aggregate reports under `results/blind/`. Presidio,
scrubadub, and DataFog use the same optional virtual environments as
`bench:compare`.
PII-Shield is included when its CLI and GLiNER model are installed; set
`PII_SHIELD_BIN` when the executable is not on `PATH`.

Held-out results can reject a release, but must not be used to inspect examples or
tune behavior. See the repository instructions in `AGENTS.md`.

All held-out runners use the same versioned JSON contract in
`src/sealed-report.ts`. The contract has exact fields and task-discriminated
aggregate metrics; unknown fields fail closed. The shared serializer and
Markdown renderer cannot accept document text, examples, categories,
predictions, failure cases, or per-document results. Unavailable adapters use a
fixed reason code so subprocess output cannot enter a persisted report.

Performance is reported by phase: adapter initialization, the first (cold)
complete corpus pass, and the second (warm) complete corpus pass. Warm
characters per second describes that second pass; it is not proof that the
provider reached steady state. Parent-observed
adapter wall time is retained only as diagnostic metadata because it combines
initialization, two passes, and—in subprocess adapters—runtime startup, imports,
serialization, and protocol overhead. Timings are one-shot and machine-load
sensitive; use repeated isolated runs and compare medians for performance work.

For optimization work, `bun run bench:performance` is stella's scaling harness.
`bun run bench:performance:providers` runs the controlled cross-provider lanes:
stella's full pipeline, stella regex-only, base scrubadub, and DataFog
regex-only. The harness uses only the public-safe synthetic English fixture,
expands it to 48, 256, 512, and 1,024 KiB, then starts a fresh process for every
observation.
Three warmup rounds are discarded; 20 measured rounds report every observation
plus median, median absolute deviation, and p95 for process startup, pipeline
initialization, cold detection, warm detection, and warm characters per second.
Output span count and a digest over offsets and labels must remain identical in
every process. This harness is development-only and never reads a sealed
held-out evaluation corpus.

Local runs accept smaller counts for quick verification:

```sh
bun run bench:performance --warmups=1 --samples=2 --sizes-kib=48
```

Canonical reports run only on trusted `main` pushes or manual dispatches on the
`anonymize-perf-v1` self-hosted runner after the repository variable
`ANONYMIZE_PERF_RUNNER_ENABLED` is set to `true`. Canonical mode fails closed
unless the machine matches its provisioned hardware profile, uses the
performance CPU governor with boost disabled, has an isolated physical CPU,
uses `nohz_full` adaptive ticks, and is below its declared load ceiling. Every
canonical worker is pinned to that CPU with `taskset`; local runs remain
unpinned. See `REPRODUCING.md` for
the host profile contract.

Each loader verifies the pinned artifact digest before invoking JSON, Parquet,
ZIP, or BRAT parsing. Only the public test split is reachable from the held-out
commands. Corpus attribution and pinned digests are recorded in
`ATTRIBUTION.md`.

## Unified benchmark suite

`src/suite/registry.ts` is the governance and task registry for
`stella-anon-bench`. It keeps corpus provenance, version, license, language,
domain, access mode, and usage policy next to the task semantics. Corpora are
not flattened into one score when their annotations mean different things:

- TAB: span redaction over ECHR court decisions, with independent annotators.
  The unified suite runs all 127 test judgments, not the 12-document smoke set.
- RedactionBench: mandatory/contextual character spans over 200 heterogeneous
  English artifacts, including contracts, legal forms, medical documents,
  email, financial/government records, source code, files, logs, and terminals.
- MEDDOCAN: all 250 documents in the public Spanish clinical test split,
  loaded from its checksum-pinned Zenodo archive.
- German LER: all 6,673 sentences in the public German federal-court test split.
  Because its seven coarse classes include legal norms, decisions, and
  literature, the suite reports label-agnostic entity coverage as a diagnostic;
  it does not call this PII recall or label-aware NER accuracy. The underlying
  decisions were already anonymized before annotation. The published split
  contains token sequences rather than original spacing, so the runner joins
  tokens with one space and derives all evaluated offsets from that text.
  Restricted or gated corpora are intentionally absent. A paper, model, dataset
  card, or click-through registration page is not enough: the runner only lists
  corpora it can retrieve as a versioned public artifact without credentials.

RedactionBench's official R-Score reference implementation is not yet
available. The suite therefore reports explicitly named interim metrics:
mandatory span recall, mandatory character recall, and character precision
where both mandatory and contextual spans are accepted. It does not label
those numbers as R-Score.

Libraries whose virtualenv is missing are reported as `unavailable` in the
report and skipped, rather than failing the run or being fabricated. (A venv
that exists but is missing its dependencies is likewise skipped with a
reinstall hint; any _other_ non-zero exit from a Python adapter is a real crash
and fails the run loudly instead of being hidden as `unavailable`.)

## Unseen-document comparison

To compare behaviour outside the committed fixtures, run every available
library over your own files with no ground truth:

```sh
bun run bench:compare --input path/to/file.txt
bun run bench:compare --input path/to/dir           # every readable file in dir
bun run bench:compare --input path/to/file.txt --lang de   # model hint (default en)
```

This is a behaviour comparison, not a scored benchmark: there is no
recall/precision (no gold spans). For each document it prints an aligned table
of detected spans, one row per detection region, with the offset range, common
label, a truncated excerpt, and each library's own span (or `·` if it missed
the region). It also prints per-library span totals and, for every competitor,
pairwise agreement vs stella (`both` / `stella only` / `competitor only`) over
the aligned regions. Paste any previously unseen file and compare directly.

> PRIVACY: unseen-document mode quotes excerpts of the detected entities from
> your input into the report. Pasting a sensitive file therefore prints its
> entities to disk. Output is written to `results/adhoc/` (a date-stamped
> Markdown file), which is git-ignored precisely so these reports are never
> committed. Do not commit or share them if the input was sensitive.

## Reporting principles

- Ground truth is independent of stella: the repo's `.snapshot.json` fixtures
  are stella's own output and are not used here.
- Development reports include all eight labels in the declared taxonomy,
  including labels where stella does not lead.
- Competitor versions are pinned and quoted; taxonomy mappings are deliberately
  generous to competitors. See `REPRODUCING.md`.
