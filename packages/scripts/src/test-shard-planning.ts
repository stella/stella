import { panic, Result } from "better-result";
import { readFileSync } from "node:fs";

export const API_TEST_SHARD_ENV = "API_TEST_SHARD";

export const TEST_DURATION_SOURCE = {
  measured: "measured",
} as const;

export const TEST_DURATION_HISTORY_LIMIT = 5;

export const POSTGRES_SHARD_TEST_BUDGET_SECONDS = 480;
export const POSTGRES_MIN_SHARDS = 2;
export const POSTGRES_MAX_SHARDS = 8;
export const POSTGRES_UNKNOWN_TEST_SECONDS = 5;

export type TestDuration = {
  seconds: number;
  source: typeof TEST_DURATION_SOURCE.measured;
  history?: number[];
};

export type TestDurationWeights = Record<string, TestDuration>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDurationSample = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isDurationHistory = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= TEST_DURATION_HISTORY_LIMIT &&
  value.every(isDurationSample);

/** Parses the strict duration cache shape shared by API and install-free CI. */
export const parseTestDurationWeights = (
  value: unknown,
): TestDurationWeights | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const weights: [string, TestDuration][] = [];
  for (const [file, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const seconds = entry["seconds"];
    const source = entry["source"];
    const historyValue = entry["history"];
    const history =
      historyValue === undefined || !isDurationHistory(historyValue)
        ? undefined
        : historyValue;
    if (
      Object.keys(entry).some(
        (key) => key !== "seconds" && key !== "source" && key !== "history",
      ) ||
      !isDurationSample(seconds) ||
      source !== TEST_DURATION_SOURCE.measured ||
      (historyValue !== undefined && history === undefined)
    ) {
      return undefined;
    }
    weights.push([
      file,
      {
        seconds,
        source: TEST_DURATION_SOURCE.measured,
        ...(history === undefined ? {} : { history }),
      },
    ]);
  }
  return Object.fromEntries(weights);
};

export const readTestDurationWeights = (
  value: unknown,
): TestDurationWeights => {
  const weights = parseTestDurationWeights(value);
  if (weights === undefined) {
    return panic("Invalid test duration weights");
  }
  return weights;
};

export const durationSeconds = (value: unknown): Record<string, number> => {
  const weights = parseTestDurationWeights(value);
  if (weights === undefined) {
    return panic("Invalid test duration weights");
  }
  return Object.fromEntries(
    Object.entries(weights).map(([file, { seconds }]) => [file, seconds]),
  );
};

/** Resolve missing live tests with the upper middle measured duration. */
export const testFileDurationWeights = (
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
) => {
  const measured = files
    .flatMap((file) => {
      const duration = durations[file];
      if (duration === undefined) {
        return [];
      }
      if (!isDurationSample(duration)) {
        return panic(`Invalid duration for ${file}`);
      }
      return [duration];
    })
    .toSorted((a, b) => a - b);
  const fallback = measured.at(Math.floor(measured.length / 2)) ?? 1;
  return Object.fromEntries(
    files.map((file) => [file, durations[file] ?? fallback]),
  );
};

type PartitionTestFilesOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  count: number;
};

/** Longest-first scheduling; missing measurements use the live files' median. */
export const partitionTestFiles = ({
  files,
  durations,
  count,
}: PartitionTestFilesOptions): string[][] => {
  if (!Number.isSafeInteger(count) || count < 1) {
    return panic("Test shard count must be a positive integer");
  }
  if (new Set(files).size !== files.length) {
    return panic("Test paths must be unique");
  }
  const canonicalFiles = files.toSorted();
  const weights = testFileDurationWeights(canonicalFiles, durations);
  if (count === 1) {
    return [canonicalFiles];
  }
  const weight = (file: string) => {
    const duration = weights[file];
    if (duration === undefined) {
      return panic(`Missing resolved duration for ${file}`);
    }
    return duration;
  };
  const bins = Array.from({ length: count }, () => ({
    files: new Set<string>(),
    seconds: 0,
  }));
  for (const file of canonicalFiles.toSorted(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : Number(a > b)),
  )) {
    let bin = bins.at(0);
    if (bin === undefined) {
      return panic("Test shard bins must exist");
    }
    for (const candidate of bins) {
      if (candidate.seconds < bin.seconds) {
        bin = candidate;
      }
    }
    bin.files.add(file);
    bin.seconds += weight(file);
  }
  return bins.map((bin) =>
    canonicalFiles.filter((file) => bin.files.has(file)),
  );
};

export const parseApiTestShard = (value: string | undefined) => {
  if (value === undefined || value === "") {
    return null;
  }
  const match = /^(?<index>[1-9]\d*)\/(?<count>[1-9]\d*)$/u.exec(value);
  const index = Number(match?.groups?.["index"]);
  const count = Number(match?.groups?.["count"]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index > count
  ) {
    return panic(
      `Invalid ${API_TEST_SHARD_ENV}: expected i/n with 1 <= i <= n`,
    );
  }
  return { index, count };
};

export type PostgresShardPlan = { files: string[]; seconds: number }[];

type PlanPostgresTestShardsOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  count: number;
};

export const planPostgresTestShards = ({
  files,
  durations,
  count,
}: PlanPostgresTestShardsOptions): PostgresShardPlan => {
  const measured = files
    .flatMap((file) => {
      const seconds = durations[file];
      if (seconds === undefined) {
        return [];
      }
      if (!isDurationSample(seconds)) {
        return panic(`Invalid Postgres test duration: ${file}`);
      }
      return [seconds];
    })
    .toSorted((a, b) => a - b);
  const fallback = Math.max(
    POSTGRES_UNKNOWN_TEST_SECONDS,
    measured.at(Math.floor(measured.length / 2)) ?? 0,
  );
  const weights = Object.fromEntries(
    files.map((file) => [file, durations[file] ?? fallback]),
  );
  return partitionTestFiles({ files, durations: weights, count }).map(
    (shardFiles) => {
      let seconds = 0;
      for (const file of shardFiles) {
        const duration = weights[file];
        if (duration === undefined) {
          return panic(`Missing duration: ${file}`);
        }
        seconds += duration;
      }
      return { files: shardFiles, seconds };
    },
  );
};

export const postgresShardBudgetWarnings = (
  plan: PostgresShardPlan,
  budgetSeconds = POSTGRES_SHARD_TEST_BUDGET_SECONDS,
) =>
  plan.flatMap(({ files, seconds }, index) =>
    seconds > budgetSeconds
      ? [
          `Postgres shard ${index + 1}/${plan.length} projects ${seconds.toFixed(1)}s over the ${budgetSeconds}s test budget (${files.length} files)`,
        ]
      : [],
  );

type PlanPostgresShardCountOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  budgetSeconds?: number;
  minShards?: number;
  maxShards?: number;
};

export const planPostgresShardCount = ({
  files,
  durations,
  budgetSeconds = POSTGRES_SHARD_TEST_BUDGET_SECONDS,
  minShards = POSTGRES_MIN_SHARDS,
  maxShards = POSTGRES_MAX_SHARDS,
}: PlanPostgresShardCountOptions) => {
  if (
    !Number.isSafeInteger(minShards) ||
    !Number.isSafeInteger(maxShards) ||
    minShards < 1 ||
    maxShards < minShards
  ) {
    return panic("Postgres shard bounds must satisfy 1 <= min <= max");
  }
  const total = planPostgresTestShards({ files, durations, count: 1 }).reduce(
    (sum, { seconds }) => sum + seconds,
    0,
  );
  const lowerBound = Math.min(
    maxShards,
    Math.max(minShards, Math.ceil(total / budgetSeconds)),
  );
  let plan = planPostgresTestShards({ files, durations, count: lowerBound });
  for (let count = lowerBound; count < maxShards; count += 1) {
    const reducible = plan.some(
      ({ files: shardFiles, seconds }) =>
        seconds > budgetSeconds && shardFiles.length > 1,
    );
    if (!reducible) {
      break;
    }
    plan = planPostgresTestShards({ files, durations, count: count + 1 });
  }
  return {
    count: plan.length,
    plan,
    warnings: postgresShardBudgetWarnings(plan, budgetSeconds),
  };
};

export const postgresShardMatrix = (count: number) =>
  Array.from({ length: count }, (_, index) => `${index + 1}/${count}`);

export const readPostgresTestDurations = (
  durationPath: string | undefined,
): Readonly<Record<string, number>> => {
  if (durationPath === undefined || durationPath === "") {
    console.log(
      "::notice::Postgres duration cache unavailable; using conservative estimates",
    );
    return {};
  }

  const contents = Result.try(() => readFileSync(durationPath, "utf-8"));
  if (contents.isErr()) {
    console.log(
      "::notice::Postgres duration cache unreadable; using conservative estimates",
    );
    return {};
  }

  const parsed = Result.try((): unknown => JSON.parse(contents.value));
  if (parsed.isErr()) {
    console.log(
      "::notice::Postgres duration cache unreadable; using conservative estimates",
    );
    return {};
  }
  const weights = parseTestDurationWeights(parsed.value);
  if (weights === undefined) {
    console.log(
      "::notice::Postgres duration cache has an invalid schema; using conservative estimates",
    );
    return {};
  }
  return Object.fromEntries(
    Object.entries(weights).map(([file, { seconds }]) => [file, seconds]),
  );
};
