# Reproducing the benchmark

This document records the exact toolchain, library versions, models, and
taxonomy-mapping decisions behind the numbers in `results/`. The goal is that
anyone can re-run the comparison and get the same shape of result on comparable
hardware.

## What is measured

The development comparison is configured to run `@stll/anonymize` (stella)
and five other open-source PII libraries on a public, synthetic, legal-domain
corpus (en/cs/de):

- **OpenRedaction** 1.1.5 (stateless local regex engine; learning and optional
  NER disabled).
- **Microsoft Presidio** (`presidio-analyzer`) with spaCy models.
- **scrubadub** (base install).
- **DataFog** 4.8.0 (core regex engine only; no spaCy or GLiNER extras).
- **redact-pii** 3.4.0 detector assets, vendored from the npm package.

Metrics: per-label and overall precision / recall / F1 with span-overlap
matching, plus throughput (chars/sec, cold and warm). See `src/metrics.ts`.

## Sealed public test runners

The sealed suite uses public tools and credential-free public artifacts:

| Runner         | Public source             | Parser                   | Pinned test artifact           |
| -------------- | ------------------------- | ------------------------ | ------------------------------ |
| TAB            | GitHub raw content        | built-in JSON            | repository commit plus SHA-256 |
| RedactionBench | Hugging Face dataset file | `hyparquet`              | dataset commit plus SHA-256    |
| MEDDOCAN       | Zenodo record API         | `fflate` and BRAT parser | archive SHA-256                |
| German LER     | Hugging Face dataset file | `hyparquet`              | dataset commit plus SHA-256    |

From `packages/benchmark`, run all complete test splits or one corpus:

```sh
bun run bench:sealed
bun run bench:sealed:tab
bun run bench:sealed:redactionbench
bun run bench:sealed:meddocan
bun run bench:sealed:german-ler
```

The runners download into `.cache/`, enforce byte limits, verify the pinned
SHA-256 digest, and only then invoke a parser. A mismatched cached file is not
parsed. Generated JSON and Markdown share the exact aggregate-only schema in
`src/sealed-report.ts`; no raw text, examples, category breakdowns,
predictions, failure cases, or per-document records are persisted or printed.
The three native task semantics remain separate and are never combined into a
suite-wide score. See `ATTRIBUTION.md` for public provenance and licenses.

## Hardware / runtime note

The committed run under `results/` was produced on Apple M3 (8 cores), 24 GiB
RAM, macOS, with Bun 1.3.14 and CPython 3.11.12. Throughput is a single run on
one machine; treat it as order-of-magnitude, not a precise micro-benchmark.
Recall/precision are deterministic and machine-independent.

### Canonical performance host

The quality runners above are intentionally portable. Optimization decisions
use the separate process-isolated scaling harness:

```sh
bun run bench:performance
```

Its defaults are three discarded warmup rounds and 20 measured rounds at 48,
256, 512, and 1,024 KiB. Each observation starts a new Bun process and records
startup, full pipeline initialization, cold detection, and warm detection
separately. The JSON report contains the raw observations, median, median
absolute deviation, p95, machine metadata, and deterministic input/output
digests. It contains no source text or sealed-corpus result.

The canonical GitHub workflow targets only the self-hosted
`anonymize-perf-v1` label. Until the runner exists, leave the repository
variable `ANONYMIZE_PERF_RUNNER_ENABLED` unset so trusted pushes skip the job
instead of waiting for an offline machine. Provision the runner with
`/etc/stella-anonymize/perf-host-v1.json`:

```json
{
  "schemaVersion": 1,
  "label": "anonymize-perf-v1",
  "platform": "linux",
  "architecture": "x64",
  "cpuModel": "replace with the exact node:os CPU model",
  "logicalCores": 8,
  "totalMemoryBytes": 17179869184,
  "benchmarkCpu": 6,
  "maximumLoadPerCore": 0.1,
  "governor": "performance",
  "turbo": "disabled"
}
```

These values are an example, not the canonical hardware specification. Record
the provisioned machine's exact values. `--canonical` accepts only a manual run
of `main` or a `main` push in `stella/anonymize`; it also verifies the CPU,
memory (within 1%), load ceiling, Linux scaling governor, and disabled
turbo/boost state before measuring. The declared `benchmarkCpu` must be online,
listed by Linux in `/sys/devices/system/cpu/isolated`, and have no online SMT
sibling. It must also appear in `/sys/devices/system/cpu/nohz_full`, which
keeps regular scheduler ticks off the measurement CPU. Every canonical worker runs through
`taskset --cpu-list <benchmarkCpu>`; the selected logical CPU is recorded in
the report. Provider runs record per-CPU nice, I/O-wait, IRQ, soft-IRQ, and
steal-time deltas; any such non-benchmark CPU noise fails the canonical run. The
host load ceiling is checked again after measurement. Missing profile,
`taskset`, isolation, or sysfs controls fail the
run instead of silently producing non-comparable numbers. Local mode does not
pin processes and records a null benchmark CPU.

### Cross-provider throughput

The separate provider harness runs the same public-safe synthetic English text
through stella's full pipeline, stella's built-in regex detectors with all
non-regex support data removed, OpenRedaction's stateless local configuration,
base scrubadub, and DataFog's regex-only engine:

```sh
bun run bench:performance:providers
```

Each observation uses a fresh process, followed by a first and second call.
Startup ends when the worker interpreter is ready; provider imports and pipeline
loading are recorded as initialization. stella's full-pipeline lane reads the
shipped English prepared package; its regex-only lane assembles the intentionally
narrow detector configuration. The parent also records the paired
spawn-to-clean-exit wall duration, and each worker records total process CPU
time. These paired values are the end-to-end comparison; phase medians must not
be added together. Canonical mode uses the same host
verification and `taskset` CPU pinning contract as `bench:performance`.
The workflow pins uv 0.10.1 and CPython 3.11.12, then creates fresh virtualenvs
from hash-locked requirement closures before it waits for the host to become
quiet. Provider-size pairs use paired forward/reverse rotations so every
coordinate's mean execution position is exactly balanced across measured
rounds; canonical runs therefore require an even sample count.

The scopes are deliberately explicit. stella's regex-detector lane,
OpenRedaction's local configuration, and DataFog's regex engine are the closest
like-for-like rows, but their pattern sets, context processing, and result
resolution differ. stella full and scrubadub base run different, broader
detector sets. Every row
records its detection count, per-label counts, and output digest, so a fast
provider cannot appear to win by doing no work. Throughput uses JavaScript
UTF-16 code units across every provider; each worker recomputes and verifies the
input bytes, denominator, and SHA-256 independently. Python virtualenvs default to
`.venv-scrubadub` and `.venv-datafog`; override their interpreters with
`ANONYMIZE_SCRUBADUB_PYTHON` and `ANONYMIZE_DATAFOG_PYTHON` when needed.

## Pinned toolchain versions

| Component                             | Version |
| ------------------------------------- | ------- |
| Bun                                   | 1.3.14  |
| stella (`@stll/anonymize`)            | 2.7.3   |
| OpenRedaction (`@openredaction/core`) | 1.1.5   |
| redact-pii (npm)                      | 3.4.0   |
| Python                                | 3.11.12 |
| presidio-analyzer                     | 2.2.360 |
| presidio-anonymizer                   | 2.2.360 |
| spaCy                                 | 3.8.7   |
| en_core_web_lg                        | 3.8.0   |
| de_core_news_lg                       | 3.8.0   |
| es_core_news_lg                       | 3.8.0   |
| xx_ent_wiki_sm (used for Czech)       | 3.8.0   |
| scrubadub                             | 2.0.1   |
| phonenumbers                          | 8.13.55 |

## Steps

### 0. Build the workspace

The stella adapter needs the native binding. From the repo root:

```sh
bun install
bun run build
```

### 1. stella, OpenRedaction, and redact-pii (Node/Bun)

No extra setup. stella is a workspace dependency and OpenRedaction's core
package is pinned in the Bun lockfile. The exact regexp and name-list assets
used by the redact-pii 3.4.0 adapter are committed under
`vendor/redact-pii/3.4.0/` with their upstream license and checksums. The adapter
does not install redact-pii's unused Google DLP dependency tree.

### 2. Presidio virtualenv (Python)

Uses [uv](https://github.com/astral-sh/uv). From `packages/benchmark`:

```sh
uv venv .venv-presidio --python 3.11
uv pip install --python .venv-presidio -r python/requirements-presidio.txt
uv pip install --python .venv-presidio \
  "https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl" \
  "https://github.com/explosion/spacy-models/releases/download/de_core_news_lg-3.8.0/de_core_news_lg-3.8.0-py3-none-any.whl" \
  "https://github.com/explosion/spacy-models/releases/download/es_core_news_lg-3.8.0/es_core_news_lg-3.8.0-py3-none-any.whl" \
  "https://github.com/explosion/spacy-models/releases/download/xx_ent_wiki_sm-3.8.0/xx_ent_wiki_sm-3.8.0-py3-none-any.whl"
```

If the venv is missing, the runner reports Presidio as `unavailable` and
continues with the other libraries rather than failing.

### 3. scrubadub virtualenv (Python)

```sh
uv venv .venv-scrubadub --python 3.11
uv pip install --python .venv-scrubadub -r python/requirements-scrubadub.txt
```

### 4. DataFog virtualenv (Python, model-free)

The requirements file pins DataFog and its complete core dependency closure.
It does not install the `nlp` or `nlp-advanced` extras.

```sh
uv venv .venv-datafog --python 3.11
uv pip install --python .venv-datafog -r python/requirements-datafog.txt
```

### 5. Optional German PII-assisted lane (local ONNX)

The default stella adapter remains deterministic and model-free. An explicit
German-only lane combines it with the MIT-licensed
[`Wismut/nym-pii-multilingual-small`](https://huggingface.co/Wismut/nym-pii-multilingual-small)
token-classification model. The adapter pins revision
`4348999cd3c2e20c49615e9af7c6bbb45b64cd85` and its `int8/` ONNX export; it does
not follow a moving model branch. The approximately 133 MiB model is downloaded
into the benchmark's ignored `.cache/` directory on first use and all inference
remains local. The exact artifacts total 151,126,561 bytes (138,730,982-byte
model plus tokenizer and config); each has a committed expected size and
SHA-256. The current upstream card's historical 70 MB row describes the older
v2 int8 model, not the pinned v3 artifact. CPU ONNX inference is expected to
dominate runtime and to be substantially slower than model-free stella on short
documents; the runner reports model load, cold-pass, and warm-pass timings
separately instead of hiding that cost.

The model was trained on multilingual synthetic PII plus LLM-labelled
Wikipedia, not the German LER corpus. Its upstream model card reports a
recall-leaning operating point and warns that ambiguous spans may be
over-flagged; this lane is therefore an optional provider, not a compliance
claim or a replacement for stella's deterministic detectors. No text is sent
to an API or written to benchmark output.

```sh
# Build the isolated benchmark-only Rust binary. It is deliberately not a
# member of stella's release workspace and does not affect default binaries.
cargo build --release --locked \
  --manifest-path native/nym-adapter/Cargo.toml

# Independently authored, public-safe German legal development fixtures only:
bun run bench:dev:nym-assisted

# Sealed aggregate-only German LER run (requires a clean committed tree):
bun run bench:sealed:german-ler:assisted
```

Provider output uses Unicode code-point offsets and is imported through the
public `ExternalDetectionBatch` v1 contract, including a document SHA-256 and
the exact provider revision. stella then performs its normal overlap
resolution. The mapping is intentionally PII-only: unsupported Nym concepts
are dropped, and legal citations, statutes, cases, and other non-PII legal NER
classes are not flattened into a generic PII label. Accordingly, German LER's
label-agnostic score is only a coverage diagnostic for this assisted lane, not
label-aware legal NER accuracy.

The optional adapter uses native Rust `ort` and Hugging Face `tokenizers`; there
is no Python, NumPy, transformers, or provider-specific TypeScript decoder. Its
standalone Cargo lock pins the complete native toolchain, including the matching
`ort`/`ort-sys` release-candidate pair. The release binary and ONNX Runtime
dynamic library live under `native/nym-adapter/target/`, which is ignored and
never shipped with stella packages.

### 6. Run

```sh
bun run bench:compare
```

Writes `results/<date>.json`, `results/<date>.md`, and `results/latest.md`.

## Corpus and ground truth

The corpus lives in `fixtures/` as per-language JSON. Each document is an
ordered list of segments; plain strings are non-PII filler and objects carry a
labelled entity. The loader (`src/ground-truth.ts`) concatenates segment text
and derives every entity's `[start, end)` from its position, so offsets are
correct by construction and reviewable in the diff.

All text is **public-safe synthetic** legal prose: invented people, companies,
and identifiers. The repo's `.snapshot.json` contract fixtures are stella's own
pipeline output and are deliberately NOT used as ground truth (that would be
circular). Offsets are UTF-16 code units; fixtures avoid astral-plane
characters, so UTF-16 offsets equal provider offsets for the development corpus.
The native Nym adapter separately tests astral Unicode conversion through the
public external-detection contract.

## Common taxonomy and per-library mapping

Every library reports its own label vocabulary. To compare fairly, each
library's native labels are mapped onto eight common categories. The coarseness
is a fairness choice: libraries that lump identifiers together are not penalised,
and stella's finer labels are collapsed the same way. The authoritative mapping
is `src/taxonomy.ts`; a summary:

Common labels: `person`, `organization`, `address`, `email`, `phone`,
`id-number`, `date`, `money`.

| Common label | stella                                                                                                                 | OpenRedaction                                 | Presidio                                                                                                                                     | scrubadub                                                                                                                    | DataFog                              | redact-pii                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------- |
| person       | person                                                                                                                 | NAME, EMERGENCY_CONTACT                       | PERSON                                                                                                                                       | —                                                                                                                            | —                                    | names                                    |
| organization | organization                                                                                                           | —                                             | ORGANIZATION / ORG                                                                                                                           | —                                                                                                                            | —                                    | —                                        |
| address      | address, country, land parcel                                                                                          | postcode, ZIP code, street, PO box            | LOCATION, GPE, NRP, ADDRESS                                                                                                                  | —                                                                                                                            | ZIP_CODE, DE_POSTAL_CODE             | streetAddress, zipcode                   |
| email        | email address                                                                                                          | EMAIL                                         | EMAIL_ADDRESS                                                                                                                                | email                                                                                                                        | EMAIL                                | emailAddress                             |
| phone        | phone number                                                                                                           | UK, US, and international phone patterns      | PHONE_NUMBER                                                                                                                                 | phone                                                                                                                        | PHONE                                | phoneNumber                              |
| id-number    | bank account, iban, tax id, identity card, birth number, national id, ssn, registration, credit card, passport, crypto | financial, government, and travel identifiers | US_SSN, US_ITIN, US_PASSPORT, US_DRIVER_LICENSE, US_BANK_NUMBER, IBAN_CODE, CREDIT_CARD, CRYPTO, MEDICAL_LICENSE, UK_NHS, IN_PAN, IN_AADHAAR | credit_card, social_security_number, drivers_licence, national_insurance_number, tax_reference_number, vehicle_licence_plate | CREDIT_CARD, SSN, German identifiers | creditCardNumber, usSocialSecurityNumber |
| date         | date, date of birth                                                                                                    | DATE, DATE_OF_BIRTH                           | DATE_TIME                                                                                                                                    | —                                                                                                                            | DATE                                 | —                                        |
| money        | monetary amount                                                                                                        | —                                             | —                                                                                                                                            | —                                                                                                                            | —                                    | —                                        |

`—` means the library has no recognizer that maps to that category, so it scores
zero recall there (reported, not hidden). scrubadub's base install ships no name
detector (it needs the optional `scrubadub_spacy`/`scrubadub_stanford` plugin,
not installed here), so `person` is deliberately left out of scrubadub's mapping
in `src/taxonomy.ts`: the base library can never emit a name, and listing it
would inflate scrubadub's supported-labels denominator with a category it does
not attempt. scrubadub's supported labels are therefore `email`, `phone`, and
`id-number` (3/8).

Native labels mapped to `null` in `src/taxonomy.ts` (URLs, usernames, IP
addresses, Twitter handles, credentials) are dropped before scoring, so a
library is never charged a false positive for correctly detecting a real
category the ground truth does not track.

DataFog's model-free mapping covers five common labels: `EMAIL` to `email`,
`PHONE` to `phone`, `DATE` to `date`, ZIP/postal labels to `address`, and its
credit-card, SSN, German VAT, IBAN, tax, social-security, passport, and
residence-permit labels to `id-number`. `IP_ADDRESS` is out of scope and maps
to `null`. Person, organization, and money are unsupported by this engine.

OpenRedaction's stateless local engine maps its generic name, address, email,
phone, and date patterns directly. The identifier labels exercised by the
development corpus map to the coarse `id-number` label. Every native label
emitted on that corpus is explicitly mapped or marked out of scope; a test
guards this coverage. Hundreds of other industry-specific labels remain outside
the development corpus's eight-label taxonomy. Sealed label-agnostic tasks
still evaluate every returned span. Organization and money are unsupported by
the default regex engine.

### Mapping fairness decisions

- **Presidio NRP/GPE/LOCATION -> address.** NRP (nationalities, religious and
  political groups) is folded into `address` as the closest bucket; this is
  generous to Presidio (it converts some would-be false positives into possible
  true positives).
- **Coarse `id-number`.** All government/financial identifiers collapse to one
  bucket for every library, so no library is penalised for not distinguishing a
  passport number from a tax id.
- **Czech via multilingual model.** Presidio has no first-party Czech pipeline,
  so Czech uses `xx_ent_wiki_sm`, which has PER/LOC/ORG/MISC but no DATE. Czech
  date recall for Presidio is therefore structurally zero; this is a real
  limitation, reported in the per-language table.

## Adapter faithfulness notes

- **stella** loads the shipped language-scoped prepared packages and runs the
  native product-default rules and dictionary bundle with NER off
  (`src/adapters/stella.ts`). Caller-owned config assembly remains covered by
  the separate performance and assisted-adapter paths. This replaces the older
  benchmark-only neutral-dictionary assembly path, so stella quality and timing
  are not directly comparable with reports generated before this change.
- **OpenRedaction** runs the pinned package's local configuration with all 579
  built-in regex patterns plus its heuristic context processing. Its
  working-directory learning store is disabled so local state cannot change
  predictions. Its optional NER path is also disabled: it requires an
  undeclared English-only dependency and is not reproducible across the
  benchmark's languages. Native positions are already UTF-16 offsets.
- **Presidio** is configured multilingually with the language-agnostic pattern
  recognizers enabled for all three languages (`python/presidio_adapter.py`).
- **scrubadub** runs its default `Scrubber()`; the active detector set is
  recorded in the JSON output and the report's adapter notes.
- **DataFog** runs `scan(..., engine="regex")` from the core package. German
  documents select its upstream `de` locale; other documents use only the base
  structured detectors. No optional NER engine or model is installed.
- **redact-pii** is a redaction library that returns masked text, not spans. The
  adapter recovers spans by running redact-pii's own detectors over the original
  text: the exported regexp built-ins via `matchAll`, and a faithful
  reproduction of its `NameRedactor` (internals are not exported) loading the
  same `well-known-names.json`. Those detector inputs are vendored byte-for-byte
  from the pinned 3.4.0 npm package; see the vendor README for provenance and
  checksums. Running on the original text yields a superset of what sequential
  redaction emits, so this is generous to redact-pii's recall.

## Init vs. per-document boundary (throughput fairness)

The `init (s)` column is one-time setup; `cold`/`warm` chars/sec are the
per-document detection passes. For the comparison to be fair, every library's
own one-time cost must fall inside `init`, not be hidden at import time or folded
into the per-document loop. What counts as init for each adapter:

| Library       | Counted as init (one-time)                                                    | Per document (cold/warm)       |
| ------------- | ----------------------------------------------------------------------------- | ------------------------------ |
| stella        | load native binding; read and decode one trusted shipped package per language | `redactText` per doc           |
| OpenRedaction | construct a stateless local detector and compile its 579 built-in patterns    | `detect` per doc               |
| Presidio      | load the three spaCy models and build the analyzer/recognizer registry        | `analyzer.analyze` per doc     |
| scrubadub     | construct `Scrubber()` (instantiates its detectors)                           | `iter_filth` per doc           |
| DataFog       | no explicit pipeline; first-use regex compilation remains in the cold pass    | `scan(..., engine="regex")`    |
| redact-pii    | load built-in pattern list + well-known-names, compile regexes                | run compiled detectors per doc |

stella's binding and prepared-package loading are timed inside `init`
(`src/adapters/stella.ts`). This measures the released product path instead of
charging runtime package assembly that normal consumers perform at build time.
Lazy regex compilation remains in the cold pass. redact-pii's pattern/name-list
load and regex compilation are
likewise timed as init rather than left as a module-load side effect
(`src/adapters/redact-pii.ts`). Python init is measured inside each Python
process and excludes interpreter startup, which is reported separately in prose.

Sealed reports preserve these phase timings instead of collapsing them into a
generic duration. Their throughput headline is the second complete corpus pass
(`warm chars/s`). The parent-observed adapter wall duration is diagnostic only:
it combines init, two passes, subprocess startup/imports, JSON protocol work,
and result validation. Because imports occur outside some adapters' internal
init timer, init values are useful within the declared boundary but are not a
universal process-start comparison. All wall timings are machine-load sensitive;
for performance conclusions, run providers in isolation at least three times
and compare medians.

## Provenance of committed results

The `sourceGitSha` field records the full 40-character SHA of the clean source
tree that produced a sealed result. A sealed runner fails before loading a
corpus when tracked source changes, staged changes, or unrelated untracked
files are present. Canonical aggregate report pairs emitted by an earlier
sealed phase for the same source SHA are the only untracked files ignored, so
TAB, RedactionBench, MEDDOCAN, and German LER can run sequentially without
weakening the provenance check.

For reports produced on a PR branch, the recorded source SHA is a PR-branch
commit. This repository squash-merges, so that commit will not be on `main`'s
first-parent history; it remains fetchable via the pull request head ref
(`git fetch origin pull/<PR>/head`). Recording the post-squash SHA is impossible
by construction because it does not exist until after the results are committed.
Runs from a trusted `main` push or manual dispatch instead record the clean
`main` commit used by that run.
