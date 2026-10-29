export const API_TEST_SHARD_ENV = "API_TEST_SHARD";

export const TEST_DURATION_SOURCE = {
  measured: "measured",
} as const;

export const TEST_DURATION_HISTORY_LIMIT = 5;

export const POSTGRES_SHARD_TEST_BUDGET_SECONDS = 480;
export const POSTGRES_MIN_SHARDS = 2;
export const POSTGRES_MAX_SHARDS = 8;
export const POSTGRES_UNKNOWN_TEST_SECONDS = 5;

type TestDuration = {
  seconds: number;
  source: typeof TEST_DURATION_SOURCE.measured;
  history?: number[];
};

type TestDurationWeights = Record<string, TestDuration>;

// CI invokes this planner before installation; failures stay data at this owner.
export type TestShardPlanningResult<T> =
  { status: "ok"; value: T } | { status: "invalid"; message: string };

const ok = <T>(value: T): TestShardPlanningResult<T> => ({
  status: "ok",
  value,
});

const invalid = (message: string): TestShardPlanningResult<never> => ({
  status: "invalid",
  message,
});

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
): TestShardPlanningResult<TestDurationWeights> => {
  const weights = parseTestDurationWeights(value);
  if (weights === undefined) {
    return invalid("Invalid test duration weights");
  }
  return ok(weights);
};

export const durationSeconds = (
  value: unknown,
): TestShardPlanningResult<Record<string, number>> => {
  const weights = readTestDurationWeights(value);
  if (weights.status === "invalid") {
    return weights;
  }
  return ok(
    Object.fromEntries(
      Object.entries(weights.value).map(([file, { seconds }]) => [
        file,
        seconds,
      ]),
    ),
  );
};

/** Resolve missing live tests with the upper middle measured duration. */
export const testFileDurationWeights = (
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
): TestShardPlanningResult<Record<string, number>> => {
  const measured: number[] = [];
  for (const file of files) {
    const duration = durations[file];
    if (duration === undefined) {
      continue;
    }
    if (!isDurationSample(duration)) {
      return invalid(`Invalid duration for ${file}`);
    }
    measured.push(duration);
  }
  measured.sort((a, b) => a - b);
  const fallback = measured.at(Math.floor(measured.length / 2)) ?? 1;
  return ok(
    Object.fromEntries(
      files.map((file) => [file, durations[file] ?? fallback]),
    ),
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
}: PartitionTestFilesOptions): TestShardPlanningResult<string[][]> => {
  if (!Number.isSafeInteger(count) || count < 1) {
    return invalid("Test shard count must be a positive integer");
  }
  if (new Set(files).size !== files.length) {
    return invalid("Test paths must be unique");
  }
  const canonicalFiles = files.toSorted();
  const weights = testFileDurationWeights(canonicalFiles, durations);
  if (weights.status === "invalid") {
    return weights;
  }
  if (count === 1) {
    return ok([canonicalFiles]);
  }
  const weightedFiles: { file: string; seconds: number }[] = [];
  for (const file of canonicalFiles) {
    const seconds = weights.value[file];
    if (seconds === undefined) {
      return invalid(`Missing resolved duration for ${file}`);
    }
    weightedFiles.push({ file, seconds });
  }
  const bins = Array.from({ length: count }, () => ({
    files: new Set<string>(),
    seconds: 0,
  }));
  for (const { file, seconds } of weightedFiles.toSorted(
    (a, b) =>
      b.seconds - a.seconds || (a.file < b.file ? -1 : Number(a.file > b.file)),
  )) {
    let bin = bins.at(0);
    if (bin === undefined) {
      return invalid("Test shard bins must exist");
    }
    for (const candidate of bins) {
      if (candidate.seconds < bin.seconds) {
        bin = candidate;
      }
    }
    bin.files.add(file);
    bin.seconds += seconds;
  }
  return ok(
    bins.map((bin) => canonicalFiles.filter((file) => bin.files.has(file))),
  );
};

export const parseApiTestShard = (
  value: string | undefined,
): TestShardPlanningResult<null | { index: number; count: number }> => {
  if (value === undefined || value === "") {
    return ok(null);
  }
  const match = /^(?<index>[1-9]\d*)\/(?<count>[1-9]\d*)$/u.exec(value);
  const index = Number(match?.groups?.["index"]);
  const count = Number(match?.groups?.["count"]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index > count
  ) {
    return invalid(
      `Invalid ${API_TEST_SHARD_ENV}: expected i/n with 1 <= i <= n`,
    );
  }
  return ok({ index, count });
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
}: PlanPostgresTestShardsOptions): TestShardPlanningResult<PostgresShardPlan> => {
  const measured: number[] = [];
  for (const file of files) {
    const seconds = durations[file];
    if (seconds === undefined) {
      continue;
    }
    if (!isDurationSample(seconds)) {
      return invalid(`Invalid Postgres test duration: ${file}`);
    }
    measured.push(seconds);
  }
  measured.sort((a, b) => a - b);
  const fallback = Math.max(
    POSTGRES_UNKNOWN_TEST_SECONDS,
    measured.at(Math.floor(measured.length / 2)) ?? 0,
  );
  const weights = Object.fromEntries(
    files.map((file) => [file, durations[file] ?? fallback]),
  );
  const partition = partitionTestFiles({ files, durations: weights, count });
  if (partition.status === "invalid") {
    return partition;
  }
  const plan: PostgresShardPlan = [];
  for (const shardFiles of partition.value) {
    let seconds = 0;
    for (const file of shardFiles) {
      const duration = weights[file];
      if (duration === undefined) {
        return invalid(`Missing duration: ${file}`);
      }
      seconds += duration;
    }
    plan.push({ files: shardFiles, seconds });
  }
  return ok(plan);
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
}: PlanPostgresShardCountOptions): TestShardPlanningResult<{
  count: number;
  plan: PostgresShardPlan;
  warnings: string[];
}> => {
  if (
    !Number.isSafeInteger(minShards) ||
    !Number.isSafeInteger(maxShards) ||
    minShards < 1 ||
    maxShards < minShards
  ) {
    return invalid("Postgres shard bounds must satisfy 1 <= min <= max");
  }
  const initial = planPostgresTestShards({ files, durations, count: 1 });
  if (initial.status === "invalid") {
    return initial;
  }
  const total = initial.value.reduce((sum, { seconds }) => sum + seconds, 0);
  const lowerBound = Math.min(
    maxShards,
    Math.max(minShards, Math.ceil(total / budgetSeconds)),
  );
  let planned = planPostgresTestShards({
    files,
    durations,
    count: lowerBound,
  });
  if (planned.status === "invalid") {
    return planned;
  }
  for (let count = lowerBound; count < maxShards; count += 1) {
    const reducible = planned.value.some(
      ({ files: shardFiles, seconds }) =>
        seconds > budgetSeconds && shardFiles.length > 1,
    );
    if (!reducible) {
      break;
    }
    planned = planPostgresTestShards({
      files,
      durations,
      count: count + 1,
    });
    if (planned.status === "invalid") {
      return planned;
    }
  }
  const plan = planned.value;
  return ok({
    count: plan.length,
    plan,
    warnings: postgresShardBudgetWarnings(plan, budgetSeconds),
  });
};

export const postgresShardMatrix = (count: number) =>
  Array.from({ length: count }, (_, index) => `${index + 1}/${count}`);
