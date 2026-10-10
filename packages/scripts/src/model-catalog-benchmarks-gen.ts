#!/usr/bin/env bun
/**
 * Generates `packages/ai-catalog/src/benchmarks.gen.ts` from the Text Arena
 * (LMArena) leaderboard dataset on Hugging Face.
 *
 * Only the rows referenced by the hand-reviewed `MODEL_BENCHMARK_SOURCES`
 * are written, in catalogue order. `--check` regenerates in memory and fails
 * with a field-level diff when the committed snapshot differs, or when a
 * referenced source id is no longer ranked upstream. Unavailable benchmark
 * pages are inconclusive in check mode; scheduled checks persist the outage
 * start with --state-file and fail only after an outage lasts more than 7 days.
 *
 *   bun --filter @stll/ai-catalog gen:benchmarks
 *   bun packages/scripts/src/model-catalog-benchmarks-gen.ts --check
 */
import { Result, TaggedError } from "better-result";
import type { TaggedErrorClass } from "better-result";
import path from "node:path";

import { BYOK_MODEL_OPTIONS, TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import {
  MODEL_BENCHMARK_CATEGORY,
  MODEL_BENCHMARK_CONFIG,
  MODEL_BENCHMARK_DATASET,
  MODEL_BENCHMARK_LICENCE,
  MODEL_BENCHMARK_NAME,
  MODEL_BENCHMARK_PUBLISH_DATE,
  MODEL_BENCHMARK_RATINGS,
  MODEL_BENCHMARK_SOURCES,
  MODEL_BENCHMARK_SPLIT,
} from "@stll/ai-catalog/benchmarks";
import type { ModelBenchmarkRating } from "@stll/ai-catalog/benchmarks";
import { fetchWithTimeout } from "@stll/fetch";
import { readCappedBytes } from "@stll/skills/streaming";
import { DAY_IN_MS, Temporal } from "@stll/time";

import { formatInteger } from "./model-catalog-rates-gen";

const OUTPUT_PATH = path.resolve(
  import.meta.dir,
  "../../ai-catalog/src/benchmarks.gen.ts",
);
const FILTER_URL = "https://datasets-server.huggingface.co/filter";
const PAGE_LENGTH = 100;
const FETCH_TIMEOUT_MS = 30_000;
// A page contains at most 100 leaderboard rows, with room for upstream metadata.
const PAGE_MAX_BYTES = 1024 * 1024;
export const INCONCLUSIVE_ALERT_AFTER_MS = 7 * DAY_IN_MS;
const RATING_DECIMALS = 100;

const BenchmarkGenerationErrorBase: TaggedErrorClass<"BenchmarkGenerationError"> =
  TaggedError("BenchmarkGenerationError");

export class BenchmarkGenerationError extends BenchmarkGenerationErrorBase<{
  cause?: unknown;
  message: string;
}> {}

export type ArenaRow = ModelBenchmarkRating & {
  category: string;
  modelName: string;
  publishDate: string;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Validate one datasets-server `rows[]` entry (`{ row_idx, row }`). */
export const parseArenaRow = (
  value: unknown,
): Result<ArenaRow, BenchmarkGenerationError> => {
  if (!isObject(value) || !isObject(value["row"])) {
    return Result.err(
      new BenchmarkGenerationError({
        message: "Arena row is not an object with a `row` field",
      }),
    );
  }
  const row = value["row"];
  const modelName = row["model_name"];
  const label = typeof modelName === "string" ? modelName : "<unnamed>";
  const invalid = (field: string) =>
    Result.err(
      new BenchmarkGenerationError({
        message: `Arena row ${label}: invalid ${field}`,
      }),
    );
  if (typeof modelName !== "string" || modelName.length === 0) {
    return invalid("model_name");
  }
  const { category, rank } = row;
  const publishDate = row["leaderboard_publish_date"];
  const rating = row["rating"];
  const ratingLower = row["rating_lower"];
  const ratingUpper = row["rating_upper"];
  const voteCount = row["vote_count"];
  if (typeof category !== "string") {
    return invalid("category");
  }
  if (typeof publishDate !== "string" || !ISO_DATE_PATTERN.test(publishDate)) {
    return invalid("leaderboard_publish_date");
  }
  if (!isFiniteNumber(rating)) {
    return invalid("rating");
  }
  if (
    !isFiniteNumber(ratingLower) ||
    !isFiniteNumber(ratingUpper) ||
    ratingLower > rating ||
    rating > ratingUpper
  ) {
    return invalid("rating bounds");
  }
  if (!Number.isSafeInteger(rank) || Number(rank) < 1) {
    return invalid("rank");
  }
  if (!Number.isSafeInteger(voteCount) || Number(voteCount) < 0) {
    return invalid("vote_count");
  }
  return Result.ok({
    category,
    modelName,
    publishDate,
    rank: Number(rank),
    rating,
    ratingLower,
    ratingUpper,
    voteCount: Number(voteCount),
  });
};

type ArenaPage = {
  rows: ArenaRow[];
  totalRows: number;
};

export const parseArenaPage = (
  payload: unknown,
): Result<ArenaPage, BenchmarkGenerationError> => {
  if (
    !isObject(payload) ||
    !Array.isArray(payload["rows"]) ||
    !Number.isSafeInteger(payload["num_rows_total"]) ||
    Number(payload["num_rows_total"]) < 0
  ) {
    return Result.err(
      new BenchmarkGenerationError({
        message: "Arena page has no `rows` array or `num_rows_total`",
      }),
    );
  }
  const rows: ArenaRow[] = [];
  for (const value of payload["rows"]) {
    const parsed = parseArenaRow(value);
    if (Result.isError(parsed)) {
      return parsed;
    }
    rows.push(parsed.value);
  }
  return Result.ok({ rows, totalRows: Number(payload["num_rows_total"]) });
};

const pageUrl = (offset: number): string => {
  const url = new URL(FILTER_URL);
  url.searchParams.set("dataset", MODEL_BENCHMARK_DATASET);
  url.searchParams.set("config", MODEL_BENCHMARK_CONFIG);
  url.searchParams.set("split", MODEL_BENCHMARK_SPLIT);
  url.searchParams.set("where", `"category"='${MODEL_BENCHMARK_CATEGORY}'`);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("length", String(PAGE_LENGTH));
  return url.toString();
};

export type BenchmarkInconclusive = {
  status: "inconclusive";
  reason: string;
  httpStatus: number | null;
  pageOffset: number;
};

const BenchmarkFetchErrorBase = TaggedError("BenchmarkFetchError");
class BenchmarkFetchError extends BenchmarkFetchErrorBase<{
  message: string;
  outcome: BenchmarkInconclusive;
}> {}

type ArenaFetch = (url: string) => Promise<Response>;

const fetchPage = async (
  offset: number,
  fetchArenaPage: ArenaFetch,
): Promise<Result<ArenaPage, BenchmarkFetchError>> => {
  let httpStatus: number | null = null;
  const inconclusive = (message: string) =>
    new BenchmarkFetchError({
      message,
      outcome: {
        status: "inconclusive",
        reason: message,
        httpStatus,
        pageOffset: offset,
      },
    });
  const fetched = await Result.tryPromise({
    try: async () => {
      const response = await fetchArenaPage(pageUrl(offset));
      httpStatus = response.status;
      const bytes =
        response.body === null
          ? new Uint8Array()
          : await readCappedBytes(response.body, PAGE_MAX_BYTES);
      return {
        payload: bytes === null ? null : new TextDecoder().decode(bytes),
        status: response.status,
      };
    },
    catch: (cause) =>
      inconclusive(
        `Arena page at offset ${offset} failed to load: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });
  if (Result.isError(fetched)) {
    return fetched;
  }
  const { payload, status } = fetched.value;
  if (status !== 200) {
    return Result.err(
      inconclusive(`Arena page at offset ${offset} responded ${status}`),
    );
  }
  if (payload === null) {
    return Result.err(
      inconclusive(
        `Arena page at offset ${offset} exceeds ${PAGE_MAX_BYTES} bytes`,
      ),
    );
  }
  const json = Result.try({
    try: (): unknown => JSON.parse(payload),
    catch: () => inconclusive(`Arena page at offset ${offset} is not JSON`),
  });
  if (Result.isError(json)) {
    return json;
  }
  const parsed = parseArenaPage(json.value);
  return Result.isError(parsed)
    ? Result.err(inconclusive(parsed.error.message))
    : Result.ok(parsed.value);
};

export const fetchArenaRows = async (
  fetchArenaPage: ArenaFetch,
): Promise<Result<ArenaRow[], BenchmarkFetchError>> => {
  const rows: ArenaRow[] = [];
  let totalRows = Number.POSITIVE_INFINITY;
  while (rows.length < totalRows) {
    const page = await fetchPage(rows.length, fetchArenaPage);
    if (Result.isError(page)) {
      return page;
    }
    if (page.value.rows.length === 0) {
      return Result.err(
        new BenchmarkFetchError({
          message: `Arena returned an empty page at offset ${rows.length} of ${page.value.totalRows}`,
          outcome: {
            status: "inconclusive",
            reason: "Arena returned an empty page",
            httpStatus: 200,
            pageOffset: rows.length,
          },
        }),
      );
    }
    totalRows = page.value.totalRows;
    rows.push(...page.value.rows);
  }
  return Result.ok(rows);
};

export type BenchmarkSnapshot = {
  publishDate: string;
  ratings: ReadonlyMap<string, ModelBenchmarkRating>;
};

/** Referenced Arena ids in catalogue order, first appearance wins. */
export const referencedSourceModelIds = (): string[] => {
  const ids = new Set<string>();
  for (const provider of TANSTACK_AI_PROVIDERS) {
    for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
      for (const { sourceModelId } of MODEL_BENCHMARK_SOURCES[modelId]) {
        ids.add(sourceModelId);
      }
    }
  }
  return [...ids];
};

const roundRating = (value: number): number =>
  Math.round(value * RATING_DECIMALS) / RATING_DECIMALS;

export const buildBenchmarkSnapshot = (
  rows: readonly ArenaRow[],
): Result<BenchmarkSnapshot, BenchmarkGenerationError> => {
  const overallRows = rows.filter(
    ({ category }) => category === MODEL_BENCHMARK_CATEGORY,
  );
  const publishDates = new Set(
    overallRows.map(({ publishDate }) => publishDate),
  );
  const publishDate = [...publishDates].at(0);
  if (publishDate === undefined || publishDates.size !== 1) {
    return Result.err(
      new BenchmarkGenerationError({
        message: `Expected one leaderboard_publish_date, found ${publishDates.size}: ${[...publishDates].join(", ")}`,
      }),
    );
  }
  const rowsByName = new Map<string, ArenaRow>();
  for (const row of overallRows) {
    if (rowsByName.has(row.modelName)) {
      return Result.err(
        new BenchmarkGenerationError({
          message: `Arena ranks ${row.modelName} twice in ${MODEL_BENCHMARK_CATEGORY}`,
        }),
      );
    }
    rowsByName.set(row.modelName, row);
  }
  const ratings = new Map<string, ModelBenchmarkRating>();
  const missing: string[] = [];
  for (const sourceModelId of referencedSourceModelIds()) {
    const row = rowsByName.get(sourceModelId);
    if (row === undefined) {
      missing.push(sourceModelId);
      continue;
    }
    ratings.set(sourceModelId, {
      rating: roundRating(row.rating),
      ratingLower: roundRating(row.ratingLower),
      ratingUpper: roundRating(row.ratingUpper),
      rank: row.rank,
      voteCount: row.voteCount,
    });
  }
  if (missing.length > 0) {
    return Result.err(
      new BenchmarkGenerationError({
        message: `Referenced source ids are not ranked upstream (update MODEL_BENCHMARK_SOURCES): ${missing.join(", ")}`,
      }),
    );
  }
  return Result.ok({ publishDate, ratings });
};

export const renderBenchmarksModule = ({
  publishDate,
  ratings,
}: BenchmarkSnapshot): string => {
  const entries = [...ratings].flatMap(([sourceModelId, rating]) => [
    `  "${sourceModelId}": {`,
    `    rating: ${rating.rating},`,
    `    ratingLower: ${rating.ratingLower},`,
    `    ratingUpper: ${rating.ratingUpper},`,
    `    rank: ${formatInteger(rating.rank)},`,
    `    voteCount: ${formatInteger(rating.voteCount)},`,
    "  },",
  ]);
  return `// AUTO-GENERATED by packages/scripts/src/model-catalog-benchmarks-gen.ts.
// Do not edit by hand: regenerate with
// \`bun --filter @stll/ai-catalog gen:benchmarks\`.
//
// Source: ${MODEL_BENCHMARK_NAME} (LMArena), Hugging Face dataset
// ${MODEL_BENCHMARK_DATASET}, config ${MODEL_BENCHMARK_CONFIG},
// split ${MODEL_BENCHMARK_SPLIT}, category ${MODEL_BENCHMARK_CATEGORY}. Licence: ${MODEL_BENCHMARK_LICENCE}.
// Only rows referenced by MODEL_BENCHMARK_SOURCES are kept, in catalogue
// order. Ratings and confidence bounds are rounded to two decimals.
import type {
  ModelBenchmarkRating,
  ModelBenchmarkSourceModelId,
} from "./benchmark-sources";

export const MODEL_BENCHMARK_PUBLISH_DATE = "${publishDate}";

export const MODEL_BENCHMARK_RATINGS = {
${entries.join("\n")}
} as const satisfies Record<ModelBenchmarkSourceModelId, ModelBenchmarkRating>;
`;
};

const RATING_FIELDS = [
  "rating",
  "ratingLower",
  "ratingUpper",
  "rank",
  "voteCount",
] as const satisfies readonly (keyof ModelBenchmarkRating)[];

/** Human-readable differences between the committed and the live snapshot. */
export const diffBenchmarkSnapshots = ({
  committed,
  live,
}: {
  committed: BenchmarkSnapshot;
  live: BenchmarkSnapshot;
}): string[] => {
  const lines: string[] = [];
  if (committed.publishDate !== live.publishDate) {
    lines.push(`publish date: ${committed.publishDate} -> ${live.publishDate}`);
  }
  for (const [sourceModelId, liveRating] of live.ratings) {
    const committedRating = committed.ratings.get(sourceModelId);
    if (committedRating === undefined) {
      lines.push(`+ ${sourceModelId}`);
      continue;
    }
    for (const field of RATING_FIELDS) {
      if (committedRating[field] !== liveRating[field]) {
        lines.push(
          `~ ${sourceModelId}.${field}: ${committedRating[field]} -> ${liveRating[field]}`,
        );
      }
    }
  }
  for (const sourceModelId of committed.ratings.keys()) {
    if (!live.ratings.has(sourceModelId)) {
      lines.push(`- ${sourceModelId}`);
    }
  }
  return lines;
};

const committedRatings: Readonly<Record<string, ModelBenchmarkRating>> =
  MODEL_BENCHMARK_RATINGS;

const committedSnapshot: BenchmarkSnapshot = {
  publishDate: MODEL_BENCHMARK_PUBLISH_DATE,
  ratings: new Map(Object.entries(committedRatings)),
};

const fail = (message: string): never => {
  console.error(message);
  return process.exit(1);
};

/**
 * The outcome decides whether an outage is open: a fetched state never carries
 * an outage start, an inconclusive one always does.
 */
type BenchmarkCheckState =
  | {
      version: 2;
      lastFetchedAt: string | null;
      inconclusiveSince: null;
      lastOutcome: { status: "fetched" };
    }
  | {
      version: 2;
      lastFetchedAt: string | null;
      inconclusiveSince: string;
      lastOutcome: BenchmarkInconclusive;
    };

const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  return Result.isOk(
    Result.try({
      try: () => Temporal.Instant.from(value),
      catch: () =>
        new BenchmarkGenerationError({ message: "Invalid timestamp" }),
    }),
  );
};

const isBenchmarkInconclusive = (
  value: unknown,
): value is BenchmarkInconclusive =>
  isObject(value) &&
  value["status"] === "inconclusive" &&
  typeof value["reason"] === "string" &&
  (value["httpStatus"] === null ||
    (Number.isSafeInteger(value["httpStatus"]) &&
      Number(value["httpStatus"]) >= 100 &&
      Number(value["httpStatus"]) <= 599)) &&
  Number.isSafeInteger(value["pageOffset"]) &&
  Number(value["pageOffset"]) >= 0;

const isFetchedOutcome = (value: unknown): value is { status: "fetched" } =>
  isObject(value) && value["status"] === "fetched";

const parseBenchmarkCheckState = (
  value: unknown,
): Result<BenchmarkCheckState, BenchmarkGenerationError> => {
  if (
    !isObject(value) ||
    value["version"] !== 2 ||
    !(value["lastFetchedAt"] === null || isIsoTimestamp(value["lastFetchedAt"]))
  ) {
    return Result.err(
      new BenchmarkGenerationError({
        message: "Invalid benchmark check state: expected version 2",
      }),
    );
  }
  const lastFetchedAt = value["lastFetchedAt"];
  const inconclusiveSince = value["inconclusiveSince"];
  const lastOutcome = value["lastOutcome"];
  if (isFetchedOutcome(lastOutcome) && inconclusiveSince === null) {
    return Result.ok({
      version: 2,
      lastFetchedAt,
      inconclusiveSince,
      lastOutcome,
    });
  }
  if (
    isBenchmarkInconclusive(lastOutcome) &&
    isIsoTimestamp(inconclusiveSince)
  ) {
    return Result.ok({
      version: 2,
      lastFetchedAt,
      inconclusiveSince,
      lastOutcome,
    });
  }
  return Result.err(
    new BenchmarkGenerationError({
      message:
        "Invalid benchmark check state: lastOutcome and inconclusiveSince disagree",
    }),
  );
};

const freshBenchmarkCheckState = (): BenchmarkCheckState => ({
  version: 2,
  lastFetchedAt: null,
  inconclusiveSince: null,
  lastOutcome: { status: "fetched" },
});

const readBenchmarkCheckState = async (
  statePath: string,
): Promise<Result<BenchmarkCheckState, BenchmarkGenerationError>> => {
  const stateFile = Bun.file(statePath);
  if (!(await stateFile.exists())) {
    return Result.ok(freshBenchmarkCheckState());
  }
  const parsed = await Result.tryPromise({
    try: async (): Promise<unknown> => stateFile.json(),
    catch: (cause) =>
      new BenchmarkGenerationError({
        cause,
        message: "Invalid benchmark check state: unreadable JSON",
      }),
  });
  return Result.isError(parsed)
    ? parsed
    : parseBenchmarkCheckState(parsed.value);
};

type BenchmarkCheckOptions = {
  fetchArenaPage: ArenaFetch;
  now: Temporal.Instant;
  outputPath?: string;
  statePath?: string;
};

export type BenchmarkCheckResult = {
  exitCode: 0 | 1;
  messages: string[];
};

export const runBenchmarkCheck = async ({
  fetchArenaPage,
  now,
  outputPath = OUTPUT_PATH,
  statePath,
}: BenchmarkCheckOptions): Promise<BenchmarkCheckResult> => {
  const previous = statePath
    ? await readBenchmarkCheckState(statePath)
    : Result.ok(freshBenchmarkCheckState());
  if (Result.isError(previous)) {
    return { exitCode: 1, messages: [previous.error.message] };
  }
  const rows = await fetchArenaRows(fetchArenaPage);
  const nowIso = now.toString();
  const state: BenchmarkCheckState = Result.isError(rows)
    ? {
        version: 2,
        lastFetchedAt: previous.value.lastFetchedAt,
        inconclusiveSince: previous.value.inconclusiveSince ?? nowIso,
        lastOutcome: rows.error.outcome,
      }
    : {
        version: 2,
        lastFetchedAt: nowIso,
        inconclusiveSince: null,
        lastOutcome: { status: "fetched" },
      };
  if (statePath) {
    await Bun.write(statePath, `${JSON.stringify(state)}\n`);
  }
  if (Result.isError(rows)) {
    const warning = `[INCONCLUSIVE] ${JSON.stringify(rows.error.outcome)}`;
    const outageStart = state.inconclusiveSince;
    if (
      statePath &&
      outageStart !== null &&
      now.epochMilliseconds -
        Temporal.Instant.from(outageStart).epochMilliseconds >
        INCONCLUSIVE_ALERT_AFTER_MS
    ) {
      return {
        exitCode: 1,
        messages: [
          warning,
          `Benchmark upstream outage has lasted more than 7 days; outage started ${outageStart}, last good fetch ${state.lastFetchedAt ?? "none"}, last outcome ${JSON.stringify(state.lastOutcome)}.`,
        ],
      };
    }
    return { exitCode: 0, messages: [warning] };
  }
  const snapshot = buildBenchmarkSnapshot(rows.value);
  if (Result.isError(snapshot)) {
    return { exitCode: 1, messages: [snapshot.error.message] };
  }
  const rendered = renderBenchmarksModule(snapshot.value);
  const outputFile = Bun.file(outputPath);
  const existing = (await outputFile.exists()) ? await outputFile.text() : null;
  if (existing === rendered) {
    return {
      exitCode: 0,
      messages: ["benchmarks.gen.ts is current with Text Arena."],
    };
  }
  const differences = diffBenchmarkSnapshots({
    committed: committedSnapshot,
    live: snapshot.value,
  });
  return {
    exitCode: 1,
    messages: [
      [
        "benchmarks.gen.ts is stale; regenerate with `bun --filter @stll/ai-catalog gen:benchmarks`.",
        ...(differences.length === 0
          ? ["(formatting differs from the generator output)"]
          : differences.map((line) => `  ${line}`)),
      ].join("\n"),
    ],
  };
};

const defaultArenaFetch: ArenaFetch = async (url) =>
  fetchWithTimeout(url, {
    headers: { accept: "application/json" },
    timeout: { type: "idle", ms: FETCH_TIMEOUT_MS },
  });

const main = async (): Promise<void> => {
  const checkOnly = Bun.argv.includes("--check");
  const stateFlag = Bun.argv.indexOf("--state-file");
  const statePath = stateFlag === -1 ? undefined : Bun.argv.at(stateFlag + 1);
  if (
    stateFlag !== -1 &&
    (!checkOnly || !statePath || statePath.startsWith("--"))
  ) {
    return fail("--state-file requires a path and --check");
  }
  if (checkOnly) {
    const result = await runBenchmarkCheck({
      fetchArenaPage: defaultArenaFetch,
      now: Temporal.Now.instant(),
      ...(statePath === undefined ? {} : { statePath }),
    });
    for (const message of result.messages) {
      if (message.startsWith("[INCONCLUSIVE]")) {
        console.warn(message);
      } else if (result.exitCode === 1) {
        console.error(message);
      } else {
        console.log(message);
      }
    }
    if (result.exitCode === 1) {
      process.exit(1);
    }
    return;
  }
  const rows = await fetchArenaRows(defaultArenaFetch);
  if (Result.isError(rows)) {
    return fail(rows.error.message);
  }
  const snapshot = buildBenchmarkSnapshot(rows.value);
  if (Result.isError(snapshot)) {
    return fail(snapshot.error.message);
  }
  const rendered = renderBenchmarksModule(snapshot.value);
  const outputFile = Bun.file(OUTPUT_PATH);
  const existing = (await outputFile.exists()) ? await outputFile.text() : null;
  if (existing === rendered) {
    console.log("benchmarks.gen.ts unchanged.");
    return;
  }
  await Bun.write(OUTPUT_PATH, rendered);
  console.log(
    `Wrote ${OUTPUT_PATH} (${snapshot.value.ratings.size} rows, ${rows.value.length} fetched).`,
  );
};

if (import.meta.main) {
  const checked = await Result.tryPromise({
    try: main,
    catch: (cause) =>
      new BenchmarkGenerationError({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  if (Result.isError(checked)) {
    fail(checked.error.message);
  }
}
