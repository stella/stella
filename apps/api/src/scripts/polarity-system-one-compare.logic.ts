/**
 * Pure half of the System One polarity comparison: argument parsing, the
 * stratified sample plan, the confusion matrix, the acceptance curve
 * `SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE` is set from, latency percentiles,
 * the input-token cost, and the Markdown report.
 *
 * The runner (`polarity-system-one-compare.ts`) owns the corpus read and the
 * model calls; nothing here reaches a database, a file or a network, so every
 * number the report prints is driven directly from
 * `polarity-system-one-compare.logic.test.ts`.
 *
 * Every tally is derived from the canonical vocabularies rather than written
 * out: a polarity added to `POLARITIES` appears in the matrix, the curve and
 * the tables without a second list being updated.
 */

import { panic, Result, TaggedError } from "better-result";

import {
  CLASSIFIABLE_POLARITIES,
  isClassifiablePolarity,
  isValidPolarity,
  POLARITIES,
} from "@/api/handlers/case-law/polarity/consts";
import type {
  ClassifiablePolarity,
  Polarity,
} from "@/api/handlers/case-law/polarity/consts";
import { SYSTEM_ONE_ERROR_KINDS } from "@/api/lib/decisions/system-one";
import type { SystemOneErrorKind } from "@/api/lib/decisions/system-one";

export class PolarityCompareArgumentError extends TaggedError(
  "PolarityCompareArgumentError",
)<{ message: string }> {}

/**
 * A citation whose `polarity` column is NULL. Distinct from `unknown`, which
 * records that the pipeline read the citation and came back with nothing:
 * `absent` means no tier ever looked at it. Neither is a reading of the text,
 * so neither can be agreed or disagreed with.
 */
export const STORED_LABEL_ABSENT = "absent";

export type StoredLabel = Polarity | typeof STORED_LABEL_ABSENT;

/** The stored vocabulary, NULL included, in the order the report tabulates. */
export const STORED_LABELS: readonly StoredLabel[] = [
  ...POLARITIES,
  STORED_LABEL_ABSENT,
];

export type UnscoredStoredLabel = Exclude<StoredLabel, ClassifiablePolarity>;

/**
 * Stored labels the comparison cannot be scored against, derived so the split
 * follows `isClassifiablePolarity` rather than a second list of names.
 */
export const UNSCORED_STORED_LABELS = STORED_LABELS.filter(
  (label): label is UnscoredStoredLabel => !isClassifiablePolarity(label),
);

/** The stored column as a label; an out-of-vocabulary value is a corpus defect. */
export const storedLabelOf = (polarity: string | null): StoredLabel => {
  if (polarity === null) {
    return STORED_LABEL_ABSENT;
  }
  return isValidPolarity(polarity)
    ? polarity
    : panic("case_law_citations.polarity holds a value outside POLARITIES", {
        polarity,
      });
};

/** Why a sampled citation was never put to the model. */
export const SAMPLE_SKIP_REASONS = [
  /** The citing decision's text lives in object storage; the column is trimmed. */
  "sections-missing",
  /** `extractContext` did not find the citation in the section it names. */
  "context-not-found",
] as const;

export type SampleSkipReason = (typeof SAMPLE_SKIP_REASONS)[number];

export type JevReading = {
  polarity: ClassifiablePolarity;
  probabilities: Record<ClassifiablePolarity, number>;
  confidence: number;
  latencyMs: number;
  inputTokens: number;
  /** The versioned model that answered, as the response reports it. */
  model: string;
};

export type JevOutcome =
  | ({ status: "read" } & JevReading)
  | { status: "failed"; kind: SystemOneErrorKind; message: string };

export type LlmOutcome =
  | {
      status: "read";
      polarity: ClassifiablePolarity;
      confidence: number;
      keyPhrase: string;
      latencyMs: number;
    }
  | { status: "failed"; message: string }
  /** `--llm` was not given: the generative tier costs generative tokens. */
  | { status: "not-run" };

/** One compared citation, as `report.json` carries it. */
export type ComparisonRow = {
  citationId: string;
  citingDecisionId: string;
  citedDecisionId: string;
  caseNumber: string;
  court: string;
  language: string;
  citationText: string;
  /** The `extractContext` window, truncated to `EXCERPT_MAX_CHARS`. */
  excerpt: string;
  stored: StoredLabel;
  jev: JevOutcome;
  llm: LlmOutcome;
};

export const EXCERPT_MAX_CHARS = 300;

/**
 * Truncated by code point (`Array.from`, not `slice`), so a report never cuts
 * a surrogate pair in half: the corpus is full of non-Latin text, and a lone
 * surrogate in `report.json` is not valid JSON text.
 */
export const truncateExcerpt = (text: string): string => {
  const points = Array.from(text);
  return points.length <= EXCERPT_MAX_CHARS
    ? text
    : `${points.slice(0, EXCERPT_MAX_CHARS - 1).join("")}…`;
};

export type LabelCount<TLabel extends string> = {
  label: TLabel;
  count: number;
};

/**
 * A tally over a closed vocabulary: seeded from the vocabulary and read back
 * in its order, so every member appears even at zero and no member can be
 * counted that the vocabulary does not name.
 */
const tallyOver = <TLabel extends string>(
  vocabulary: readonly TLabel[],
  labels: Iterable<TLabel>,
): LabelCount<TLabel>[] => {
  const counts = new Map<TLabel, number>(vocabulary.map((label) => [label, 0]));
  for (const label of labels) {
    const seen =
      counts.get(label) ??
      panic("tallied a label outside its vocabulary", { label });
    counts.set(label, seen + 1);
  }
  return vocabulary.map((label) => ({
    label,
    count:
      counts.get(label) ??
      panic("vocabulary member lost from its tally", {
        label,
      }),
  }));
};

export type PolarityCounts = readonly LabelCount<ClassifiablePolarity>[];

export type ConfusionRow = {
  stored: StoredLabel;
  /** Jev's reading of the rows carrying this stored label. */
  byJev: PolarityCounts;
  /** Rows of this stored label the tier never read. */
  failed: number;
  total: number;
};

export type AgreementCell = {
  compared: number;
  agreed: number;
  /** Null when nothing was comparable; a rate over zero rows is not zero. */
  rate: number | null;
};

export type LabelledAgreement = AgreementCell & {
  label: ClassifiablePolarity;
};

/** The floors the acceptance curve is measured at. */
export const CONFIDENCE_FLOORS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

export type AcceptancePoint = {
  floor: number;
  /** Readings at or above the floor. */
  accepted: number;
  /** Accepted over every reading the tier returned, including unscorable rows. */
  acceptedShare: number;
  /** Accepted readings whose stored label is one a classifier may assign. */
  compared: number;
  agreed: number;
  rate: number | null;
};

export type LatencySummary = {
  samples: number;
  p50: number | null;
  p95: number | null;
};

export type CostSummary = {
  inputTokens: number;
  usd: number;
  usdPerInputToken: number;
};

export type TierAgreement = {
  overall: AgreementCell;
  byStoredLabel: readonly LabelledAgreement[];
};

export type LlmSummary = {
  read: number;
  failed: number;
  agreementWithStored: TierAgreement;
  agreementWithJev: AgreementCell;
  latency: LatencySummary;
};

export type ComparisonSummary = {
  /** Citations the sample query returned. */
  sampled: number;
  /** Citations a reading was attempted for: sampled, less the skipped. */
  attempted: number;
  read: number;
  skipped: readonly LabelCount<SampleSkipReason>[];
  failures: readonly LabelCount<SystemOneErrorKind>[];
  stored: readonly LabelCount<StoredLabel>[];
  matrix: readonly ConfusionRow[];
  agreement: TierAgreement;
  /**
   * What Jev read on the rows the corpus has no reading for. Coverage the
   * corpus does not have yet, so it is reported rather than scored.
   */
  unscored: readonly {
    stored: UnscoredStoredLabel;
    read: number;
    byJev: PolarityCounts;
  }[];
  curve: readonly AcceptancePoint[];
  latency: LatencySummary;
  cost: CostSummary;
  llm: LlmSummary | null;
};

/**
 * Nearest-rank percentile: the smallest sample value at or above `share` of
 * the sample. No interpolation, so every reported latency is one a call
 * actually took.
 */
export const percentileOf = (
  values: readonly number[],
  share: number,
): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil(share * sorted.length)),
  );
  return (
    sorted[rank - 1] ??
    panic("percentile rank fell outside its own sample", {
      rank,
      size: sorted.length,
    })
  );
};

export const latencySummaryOf = (
  values: readonly number[],
): LatencySummary => ({
  samples: values.length,
  p50: percentileOf(values, 0.5),
  p95: percentileOf(values, 0.95),
});

type LabelPair = {
  left: ClassifiablePolarity;
  right: ClassifiablePolarity;
};

const agreementOf = (pairs: readonly LabelPair[]): AgreementCell => {
  const agreed = pairs.filter((pair) => pair.left === pair.right).length;
  return {
    compared: pairs.length,
    agreed,
    rate: pairs.length === 0 ? null : agreed / pairs.length,
  };
};

/** The stored label when it is one a classifier may assign, else null. */
const scorableStored = (row: ComparisonRow): ClassifiablePolarity | null =>
  isClassifiablePolarity(row.stored) ? row.stored : null;

const jevRead = (row: ComparisonRow): JevReading | null =>
  row.jev.status === "read" ? row.jev : null;

const llmRead = (
  row: ComparisonRow,
): Extract<LlmOutcome, { status: "read" }> | null =>
  row.llm.status === "read" ? row.llm : null;

type TierLabel = (row: ComparisonRow) => ClassifiablePolarity | null;

const pairsAgainstStored = (
  rows: readonly ComparisonRow[],
  tier: TierLabel,
): LabelPair[] => {
  const pairs: LabelPair[] = [];
  for (const row of rows) {
    const stored = scorableStored(row);
    const read = tier(row);
    if (stored !== null && read !== null) {
      pairs.push({ left: stored, right: read });
    }
  }
  return pairs;
};

const tierAgreementOf = (
  rows: readonly ComparisonRow[],
  tier: TierLabel,
): TierAgreement => ({
  overall: agreementOf(pairsAgainstStored(rows, tier)),
  byStoredLabel: CLASSIFIABLE_POLARITIES.map((label) => ({
    label,
    ...agreementOf(
      pairsAgainstStored(
        rows.filter((row) => scorableStored(row) === label),
        tier,
      ),
    ),
  })),
});

export const buildConfusionMatrix = (
  rows: readonly ComparisonRow[],
): ConfusionRow[] =>
  STORED_LABELS.map((stored) => {
    const ofLabel = rows.filter((row) => row.stored === stored);
    const readings = ofLabel.flatMap((row) => {
      const read = jevRead(row);
      return read === null ? [] : [read.polarity];
    });
    return {
      stored,
      byJev: tallyOver(CLASSIFIABLE_POLARITIES, readings),
      failed: ofLabel.length - readings.length,
      total: ofLabel.length,
    };
  });

const pairFor = (row: ComparisonRow, read: JevReading): LabelPair | null => {
  const stored = scorableStored(row);
  return stored === null ? null : { left: stored, right: read.polarity };
};

export const acceptanceCurve = (
  rows: readonly ComparisonRow[],
  floors: readonly number[] = CONFIDENCE_FLOORS,
): AcceptancePoint[] => {
  const readings = rows.flatMap((row) => {
    const read = jevRead(row);
    return read === null
      ? []
      : [{ confidence: read.confidence, pair: pairFor(row, read) }];
  });
  return floors.map((floor) => {
    const accepted = readings.filter((reading) => reading.confidence >= floor);
    const comparable = accepted.flatMap((reading) =>
      reading.pair === null ? [] : [reading.pair],
    );
    return {
      floor,
      accepted: accepted.length,
      acceptedShare:
        readings.length === 0 ? 0 : accepted.length / readings.length,
      ...agreementOf(comparable),
    };
  });
};

export type SummariseComparisonOptions = {
  rows: readonly ComparisonRow[];
  /** Citations the sample query returned, skipped ones included. */
  sampled: number;
  skipped: readonly SampleSkipReason[];
  /** `SYSTEM_ONE_USD_PER_INPUT_TOKEN` at the runner; a parameter so the
   * arithmetic is checked against a rate the test owns. */
  usdPerInputToken: number;
  floors?: readonly number[];
};

export const summariseComparison = ({
  rows,
  sampled,
  skipped,
  usdPerInputToken,
  floors = CONFIDENCE_FLOORS,
}: SummariseComparisonOptions): ComparisonSummary => {
  const readings = rows.flatMap((row) => {
    const read = jevRead(row);
    return read === null ? [] : [read];
  });
  const inputTokens = readings.reduce(
    (total, reading) => total + reading.inputTokens,
    0,
  );
  const llmRows = rows.filter((row) => row.llm.status !== "not-run");
  return {
    sampled,
    attempted: rows.length,
    read: readings.length,
    skipped: tallyOver(SAMPLE_SKIP_REASONS, skipped),
    failures: tallyOver(
      SYSTEM_ONE_ERROR_KINDS,
      rows.flatMap((row) =>
        row.jev.status === "failed" ? [row.jev.kind] : [],
      ),
    ),
    stored: tallyOver(
      STORED_LABELS,
      rows.map((row) => row.stored),
    ),
    matrix: buildConfusionMatrix(rows),
    agreement: tierAgreementOf(rows, (row) => jevRead(row)?.polarity ?? null),
    unscored: UNSCORED_STORED_LABELS.map((stored) => {
      const ofLabel = rows.filter((row) => row.stored === stored);
      const labels = ofLabel.flatMap((row) => {
        const read = jevRead(row);
        return read === null ? [] : [read.polarity];
      });
      return {
        stored,
        read: labels.length,
        byJev: tallyOver(CLASSIFIABLE_POLARITIES, labels),
      };
    }),
    curve: acceptanceCurve(rows, floors),
    latency: latencySummaryOf(readings.map((reading) => reading.latencyMs)),
    cost: {
      inputTokens,
      usd: inputTokens * usdPerInputToken,
      usdPerInputToken,
    },
    llm:
      llmRows.length === 0
        ? null
        : {
            read: llmRows.filter((row) => row.llm.status === "read").length,
            failed: llmRows.filter((row) => row.llm.status === "failed").length,
            agreementWithStored: tierAgreementOf(
              llmRows,
              (row) => llmRead(row)?.polarity ?? null,
            ),
            agreementWithJev: agreementOf(
              llmRows.flatMap((row) => {
                const jev = jevRead(row);
                const llm = llmRead(row);
                return jev === null || llm === null
                  ? []
                  : [{ left: jev.polarity, right: llm.polarity }];
              }),
            ),
            latency: latencySummaryOf(
              llmRows.flatMap((row) => {
                const llm = llmRead(row);
                return llm === null ? [] : [llm.latencyMs];
              }),
            ),
          },
  };
};

/** Rows where the corpus and Jev both decided, and decided differently. */
export const disagreements = (
  rows: readonly ComparisonRow[],
  limit: number,
): ComparisonRow[] =>
  rows
    .filter((row) => {
      const stored = scorableStored(row);
      const read = jevRead(row);
      return stored !== null && read !== null && stored !== read.polarity;
    })
    .slice(0, limit);

export const DISAGREEMENT_EXAMPLES = 10;

export const DEFAULT_SAMPLE_LIMIT = 200;
export const DEFAULT_CONCURRENCY = 8;
export const MAX_CONCURRENCY = 32;
export const DEFAULT_SEED = "polarity";
/** Under the package's ignored cache directory, so a report never lands in git. */
export const DEFAULT_OUT_DIR = ".cache/polarity-system-one-compare";

export type CompareOptions = {
  limit: number;
  /** Decision language to restrict the sample to; null takes any. */
  language: string | null;
  /** Roughly equal shares per stored label, NULL and `unknown` included. */
  stratify: boolean;
  /** Mixed into the sampling hash, so a run is repeatable. */
  seed: string;
  concurrency: number;
  outDir: string;
  /** Also read every row with the generative tier, for a three-way comparison. */
  llm: boolean;
  /** A pinned System One model id; null takes the deployment's. */
  model: string | null;
};

export type ParsedCompareArgs =
  | { type: "help" }
  | { type: "options"; options: CompareOptions };

export const USAGE = `Usage: bun --env-file=.env src/scripts/polarity-system-one-compare.ts [options]

  --limit <n>        Citations sampled (default ${DEFAULT_SAMPLE_LIMIT}).
  --language <code>  Citing decision language, e.g. cs (default: any).
  --stratify         Equal shares per stored polarity, NULL included (default).
  --no-stratify      Sample the population instead.
  --seed <text>      Sampling seed (default ${DEFAULT_SEED}).
  --concurrency <n>  Readings in flight (default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY}).
  --out <dir>        Report directory (default ${DEFAULT_OUT_DIR}).
  --llm              Also run the generative tier; costs generative tokens.
  --model <id>       Pin a System One model (default: TYPESAFE_MODEL).
  --help             Print this and exit.

Reads only. Needs PUBLIC_LAW_DATABASE_URL and TYPESAFE_API_KEY.`;

const VALUE_FLAGS = [
  "limit",
  "language",
  "seed",
  "concurrency",
  "out",
  "model",
] as const;

const TOGGLE_FLAGS = ["stratify", "no-stratify", "llm", "help"] as const;

const DECIMAL_INTEGER = /^\d+$/u;
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z]{2,5})?$/u;
const MAX_SEED_LENGTH = 64;

const invalid = (
  message: string,
): Result<never, PolarityCompareArgumentError> =>
  Result.err(new PolarityCompareArgumentError({ message }));

type FlagSet = { values: Map<string, string>; toggles: Set<string> };

/**
 * Strict `--flag value` parse: an unknown flag, a positional argument or a
 * repeat fails rather than being ignored, so a typo cannot silently run the
 * comparison against a default it was not asked for.
 */
const parseFlags = (
  argv: readonly string[],
): Result<FlagSet, PolarityCompareArgumentError> => {
  const values = new Map<string, string>();
  const toggles = new Set<string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv.at(index);
    if (token === undefined || !token.startsWith("--")) {
      return invalid(`unexpected argument: ${String(token)}`);
    }
    const name = token.slice(2);
    if (TOGGLE_FLAGS.some((known) => known === name)) {
      if (toggles.has(name)) {
        return invalid(`${token} was given more than once`);
      }
      toggles.add(name);
      index += 1;
      continue;
    }
    if (!VALUE_FLAGS.some((known) => known === name)) {
      return invalid(`unknown option: ${token}`);
    }
    if (values.has(name)) {
      return invalid(`${token} was given more than once`);
    }
    const value = argv.at(index + 1);
    if (value === undefined || value.startsWith("--")) {
      return invalid(`${token} requires a value`);
    }
    values.set(name, value);
    index += 2;
  }
  return Result.ok({ values, toggles });
};

const boundedInteger = ({
  raw,
  flag,
  fallback,
  max,
}: {
  raw: string | undefined;
  flag: string;
  fallback: number;
  max?: number;
}): Result<number, PolarityCompareArgumentError> => {
  if (raw === undefined) {
    return Result.ok(fallback);
  }
  const parsed = Number.parseInt(raw, 10);
  if (
    !DECIMAL_INTEGER.test(raw) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    return invalid(`--${flag} must be a positive integer, got: ${raw}`);
  }
  if (max !== undefined && parsed > max) {
    return invalid(`--${flag} must be at most ${max}, got: ${raw}`);
  }
  return Result.ok(parsed);
};

export const parseCompareArgs = (
  argv: readonly string[],
): Result<ParsedCompareArgs, PolarityCompareArgumentError> => {
  const flags = parseFlags(argv);
  if (Result.isError(flags)) {
    return flags;
  }
  const { values, toggles } = flags.value;
  if (toggles.has("help")) {
    return Result.ok({ type: "help" });
  }
  if (toggles.has("stratify") && toggles.has("no-stratify")) {
    return invalid("--stratify and --no-stratify contradict each other");
  }

  const limit = boundedInteger({
    raw: values.get("limit"),
    flag: "limit",
    fallback: DEFAULT_SAMPLE_LIMIT,
  });
  if (Result.isError(limit)) {
    return limit;
  }
  const concurrency = boundedInteger({
    raw: values.get("concurrency"),
    flag: "concurrency",
    fallback: DEFAULT_CONCURRENCY,
    max: MAX_CONCURRENCY,
  });
  if (Result.isError(concurrency)) {
    return concurrency;
  }

  const rawLanguage = values.get("language");
  // Normalized rather than refused: the flag names a corpus language, and a
  // capitalized code is the same language.
  const language =
    rawLanguage === undefined ? null : rawLanguage.trim().toLowerCase();
  if (language !== null && !LANGUAGE_CODE.test(language)) {
    return invalid(
      `--language must be a language code such as cs, got: ${rawLanguage ?? ""}`,
    );
  }

  const seed = values.get("seed") ?? DEFAULT_SEED;
  if (seed.length === 0 || seed.length > MAX_SEED_LENGTH) {
    return invalid(`--seed must be 1 to ${MAX_SEED_LENGTH} characters`);
  }

  const outDir = values.get("out") ?? DEFAULT_OUT_DIR;
  if (outDir.length === 0) {
    return invalid("--out must not be empty");
  }

  const model = values.get("model") ?? null;
  if (model?.length === 0) {
    return invalid("--model must not be empty");
  }

  return Result.ok({
    type: "options",
    options: {
      limit: limit.value,
      language,
      stratify: !toggles.has("no-stratify"),
      seed,
      concurrency: concurrency.value,
      outDir,
      llm: toggles.has("llm"),
      model,
    },
  });
};

/**
 * One query's share of the sample. Stratified, the shares are equal per stored
 * label with the remainder going to the first buckets, so a run covers the
 * rare labels (`negative`, `unknown`) that a population sample would miss.
 */
export type SampleBucket =
  | { scope: "all"; limit: number }
  | { scope: "stored-label"; label: StoredLabel; limit: number };

export const planSampleBuckets = ({
  limit,
  stratify,
}: {
  limit: number;
  stratify: boolean;
}): SampleBucket[] => {
  if (!stratify) {
    return [{ scope: "all", limit }];
  }
  const share = Math.floor(limit / STORED_LABELS.length);
  const remainder = limit % STORED_LABELS.length;
  return STORED_LABELS.map((label, index) => ({
    scope: "stored-label" as const,
    label,
    limit: share + (index < remainder ? 1 : 0),
  })).filter((bucket) => bucket.limit > 0);
};

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

const rate = (value: number | null): string =>
  value === null ? "—" : percent(value);

const ms = (value: number | null): string =>
  value === null ? "—" : `${value.toFixed(0)} ms`;

const usd = (value: number): string => `$${value.toFixed(4)}`;

/** Text as one Markdown table cell: no pipes, no line breaks. */
const cell = (text: string): string =>
  text.replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").trim();

export type RenderComparisonReportOptions = {
  summary: ComparisonSummary;
  options: CompareOptions;
  rows: readonly ComparisonRow[];
  /** The floor the cascade accepts a reading at today. */
  acceptFloor: number;
  /** The model the readings came back from; null when nothing was read. */
  model: string | null;
};

export const renderComparisonReport = ({
  summary,
  options,
  rows,
  acceptFloor,
  model,
}: RenderComparisonReportOptions): string => {
  const lines: string[] = [
    "# System One polarity, against the stored corpus labels",
    "",
    `- sample: ${summary.sampled} citations (limit ${options.limit}, seed \`${options.seed}\`, ${options.stratify ? "stratified per stored label" : "population"}, language ${options.language ?? "any"})`,
    `- read: ${summary.read} of ${summary.attempted} attempted; model ${model ?? "—"}`,
    `- agreement on stored labels: ${rate(summary.agreement.overall.rate)} over ${summary.agreement.overall.compared} citations`,
    `- latency p50 ${ms(summary.latency.p50)}, p95 ${ms(summary.latency.p95)}`,
    `- ${summary.cost.inputTokens} input tokens, ${usd(summary.cost.usd)} at ${summary.cost.usdPerInputToken} USD/token`,
    "",
    "Rows whose stored label is NULL or `unknown` are excluded from agreement:",
    "neither is a reading of the text. What Jev read on them is reported under",
    "coverage below.",
    "",
    "## Not compared",
    "",
    "| reason | citations |",
    "| --- | ---: |",
    ...summary.skipped.map(({ label, count }) => `| ${label} | ${count} |`),
    ...summary.failures.map(
      ({ label, count }) => `| read failed: ${label} | ${count} |`,
    ),
    "",
    "## Confusion matrix — stored label × Jev",
    "",
    `| stored | ${CLASSIFIABLE_POLARITIES.join(" | ")} | not read | total |`,
    `| --- | ${CLASSIFIABLE_POLARITIES.map(() => "---:").join(" | ")} | ---: | ---: |`,
    ...summary.matrix.map(
      (row) =>
        `| ${row.stored} | ${row.byJev.map(({ count }) => count).join(" | ")} | ${row.failed} | ${row.total} |`,
    ),
    "",
    "## Agreement per stored label",
    "",
    "| stored | compared | agreed | rate |",
    "| --- | ---: | ---: | ---: |",
    ...summary.agreement.byStoredLabel.map(
      (row) =>
        `| ${row.label} | ${row.compared} | ${row.agreed} | ${rate(row.rate)} |`,
    ),
    `| **all** | ${summary.agreement.overall.compared} | ${summary.agreement.overall.agreed} | ${rate(summary.agreement.overall.rate)} |`,
    "",
    "## Coverage the corpus does not have",
    "",
    `| stored | read | ${CLASSIFIABLE_POLARITIES.join(" | ")} |`,
    `| --- | ---: | ${CLASSIFIABLE_POLARITIES.map(() => "---:").join(" | ")} |`,
    ...summary.unscored.map(
      (row) =>
        `| ${row.stored} | ${row.read} | ${row.byJev.map(({ count }) => count).join(" | ")} |`,
    ),
    "",
    "## Acceptance curve",
    "",
    `The floor \`SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE\` is set from; it is ${acceptFloor} today.`,
    "Accepted share is over every reading returned; the rate is over the accepted",
    "readings whose stored label is one a classifier may assign.",
    "",
    "| floor | accepted | share | compared | agreed | rate |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.curve.map(
      (point) =>
        `| ${point.floor} | ${point.accepted} | ${percent(point.acceptedShare)} | ${point.compared} | ${point.agreed} | ${rate(point.rate)} |`,
    ),
    "",
  ];

  if (summary.llm !== null) {
    lines.push(
      "## Generative tier",
      "",
      `- read: ${summary.llm.read}, failed: ${summary.llm.failed}`,
      `- agreement on stored labels: ${rate(summary.llm.agreementWithStored.overall.rate)} over ${summary.llm.agreementWithStored.overall.compared} citations`,
      `- agreement with Jev: ${rate(summary.llm.agreementWithJev.rate)} over ${summary.llm.agreementWithJev.compared} citations`,
      `- latency p50 ${ms(summary.llm.latency.p50)}, p95 ${ms(summary.llm.latency.p95)}`,
      "",
      "| stored | compared | agreed | rate |",
      "| --- | ---: | ---: | ---: |",
      ...summary.llm.agreementWithStored.byStoredLabel.map(
        (row) =>
          `| ${row.label} | ${row.compared} | ${row.agreed} | ${rate(row.rate)} |`,
      ),
      "",
    );
  }

  const examples = disagreements(rows, DISAGREEMENT_EXAMPLES);
  lines.push(
    "## Disagreements",
    "",
    examples.length === 0
      ? "None: every compared citation was read as its stored label."
      : "Stored against Jev, for a reader to judge which is right.",
    "",
  );
  if (examples.length > 0) {
    lines.push(
      "| case | stored | Jev | confidence | citation | excerpt |",
      "| --- | --- | --- | ---: | --- | --- |",
      ...examples.map((row) => {
        const read =
          jevRead(row) ??
          panic("a disagreement carries no reading", {
            citationId: row.citationId,
          });
        return `| ${cell(row.caseNumber)} | ${row.stored} | ${read.polarity} | ${read.confidence.toFixed(2)} | ${cell(row.citationText)} | ${cell(row.excerpt)} |`;
      }),
      "",
    );
  }

  return lines.join("\n");
};
