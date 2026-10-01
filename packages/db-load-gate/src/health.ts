import { panic } from "better-result";

export type VerdictKind = "normal" | "degraded" | "stop" | "unknown";
export type HealthSignalKind = VerdictKind | "not_configured";
export type WorkKind = "index_build" | "backfill_batch";
export type Signal = {
  indicator:
    | "ebs_balance"
    | "long_transaction"
    | "autovacuum_on_target"
    | "busy_window";
  kind: HealthSignalKind;
  value: number | null;
  threshold: number | null;
  observedAt: string | null;
  reason: string;
};
export type Verdict = { kind: VerdictKind; signals: Signal[] };
export type BusyWindow = { start: string; end: string; timeZone: string };
export type HealthConfig = {
  startFloor: number;
  hardFloor: number;
  maxStalenessMs: number;
  readTimeoutMs: number;
  longTxMaxAgeMs: number;
  busyWindows: readonly BusyWindow[];
  targetDurationMs: number;
  batchStatementTimeoutMs: number;
  batchLockTimeoutMs: number;
  minSize: number;
  maxSize: number;
  minSleepMs: number;
  maxSleepMs: number;
  stableBatchesBeforeGrow: number;
  holdBackoffMs: number;
  holdBackoffCapMs: number;
  maxHeldMs: number;
};
export const defaultConfig = {
  startFloor: 70,
  hardFloor: 40,
  maxStalenessMs: 15 * 60_000,
  readTimeoutMs: 5000,
  longTxMaxAgeMs: 5 * 60_000,
  busyWindows: [{ start: "06:30", end: "08:00", timeZone: "Europe/Prague" }],
  targetDurationMs: 1000,
  batchStatementTimeoutMs: 60_000,
  batchLockTimeoutMs: 1000,
  minSize: 100,
  maxSize: 10_000,
  minSleepMs: 100,
  maxSleepMs: 30_000,
  stableBatchesBeforeGrow: 3,
  holdBackoffMs: 30_000,
  holdBackoffCapMs: 30 * 60_000,
  maxHeldMs: 6 * 60 * 60_000,
} as const satisfies HealthConfig;

export const validateConfig = (config: HealthConfig) => {
  const positiveFields = [
    config.maxStalenessMs,
    config.readTimeoutMs,
    config.longTxMaxAgeMs,
    config.targetDurationMs,
    config.batchStatementTimeoutMs,
    config.batchLockTimeoutMs,
    config.holdBackoffMs,
    config.holdBackoffCapMs,
    config.maxHeldMs,
  ];
  if (positiveFields.some((value) => !Number.isFinite(value) || value <= 0)) {
    panic("Health durations must be finite and positive");
  }
  if (
    !(
      Number.isFinite(config.startFloor) &&
      Number.isFinite(config.hardFloor) &&
      config.hardFloor >= 0 &&
      config.startFloor <= 100 &&
      config.hardFloor <= config.startFloor
    )
  ) {
    panic("Health floors must be ordered percentages");
  }
  if (
    !(
      Number.isSafeInteger(config.minSize) &&
      Number.isSafeInteger(config.maxSize) &&
      config.minSize > 0 &&
      config.maxSize >= config.minSize
    )
  ) {
    panic("Batch size bounds must be positive and ordered");
  }
  if (
    !(
      Number.isFinite(config.minSleepMs) &&
      Number.isFinite(config.maxSleepMs) &&
      config.minSleepMs >= 0 &&
      config.maxSleepMs >= config.minSleepMs
    )
  ) {
    panic("Batch sleep bounds must be finite and ordered");
  }
  if (
    !(
      Number.isSafeInteger(config.stableBatchesBeforeGrow) &&
      config.stableBatchesBeforeGrow >= 1
    )
  ) {
    panic("Stable batch count must be a positive integer");
  }
  if (config.holdBackoffCapMs < config.holdBackoffMs) {
    panic("Hold backoff cap must cover the initial backoff");
  }
  for (const window of config.busyWindows) {
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/u.test(window.start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/u.test(window.end) ||
      window.start === window.end
    ) {
      panic("Busy windows require distinct valid clock times");
    }
  }
};

const severity = {
  not_configured: 0,
  normal: 0,
  degraded: 1,
  unknown: 2,
  stop: 3,
} as const satisfies Record<HealthSignalKind, number>;

export const combine = (signals: Signal[]): Verdict => {
  let kind: VerdictKind = signals.length === 0 ? "unknown" : "normal";
  for (const signal of signals) {
    if (
      signal.kind !== "not_configured" &&
      severity[signal.kind] > severity[kind]
    ) {
      kind = signal.kind;
    }
  }
  return { kind, signals };
};

export const decideStart = (
  verdict: Verdict,
  kind: WorkKind,
  config: HealthConfig = defaultConfig,
) => {
  validateConfig(config);
  return {
    decision:
      verdict.kind === "normal" ||
      (kind === "backfill_batch" && verdict.kind === "degraded")
        ? ("start" as const)
        : ("wait" as const),
    verdict,
    config,
    kind,
  };
};

export type BuildProgress = {
  phase: string;
  blocksDone: number;
  blocksTotal: number;
};
export const decideWhileRunning = (
  history: Signal[],
  config: HealthConfig = defaultConfig,
  progress?: BuildProgress,
) => {
  validateConfig(config);
  const recent = history.slice(-2);
  const cancel =
    recent.length === 2 &&
    recent.every(
      (signal) =>
        signal.indicator === "ebs_balance" &&
        signal.kind !== "unknown" &&
        signal.value !== null &&
        Number.isFinite(signal.value) &&
        signal.value < config.hardFloor,
    );
  return {
    decision: cancel ? ("cancel" as const) : ("continue" as const),
    verdict: combine(recent),
    config,
    ...(progress === undefined ? {} : { progress }),
  };
};

export type BatchState = {
  size: number;
  sleepMs: number;
  smoothedDurationMs: number | null;
  stableBatches: number;
  holdCount: number;
  heldSince: number | null;
  holdUntil: number | null;
};
export type BatchOutcome = "success" | "statement_timeout";
export type NextBatchOptions = {
  state: BatchState;
  verdict: Verdict;
  lastDurationMs: number | null;
  config?: HealthConfig;
  clock: () => number;
  outcome?: BatchOutcome;
};

export const initialBatchState = (
  config: HealthConfig = defaultConfig,
): BatchState => ({
  size: config.minSize,
  sleepMs: config.minSleepMs,
  smoothedDurationMs: null,
  stableBatches: 0,
  holdCount: 0,
  heldSince: null,
  holdUntil: null,
});

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
export const nextBatch = ({
  state,
  verdict,
  lastDurationMs,
  config = defaultConfig,
  clock,
  outcome = "success",
}: NextBatchOptions) => {
  validateConfig(config);
  if (
    !(
      Number.isSafeInteger(state.size) &&
      state.size >= config.minSize &&
      state.size <= config.maxSize
    )
  ) {
    panic("Batch size must be an integer within configured bounds");
  }
  if (verdict.kind === "stop" || verdict.kind === "unknown") {
    const now = clock();
    const backoff = Math.min(
      config.holdBackoffCapMs,
      config.holdBackoffMs * 2 ** Math.min(state.holdCount, 52),
    );
    const nextState: BatchState = {
      size: state.size,
      sleepMs: state.sleepMs,
      smoothedDurationMs: state.smoothedDurationMs,
      stableBatches: 0,
      holdCount: state.holdCount + 1,
      heldSince: state.heldSince ?? now,
      holdUntil: now + backoff,
    };
    return {
      action: "hold" as const,
      size: state.size,
      sleepMs: state.sleepMs,
      holdUntil: nextState.holdUntil,
      heldSince: nextState.heldSince,
      state: nextState,
      verdict,
      config,
      lastDurationMs,
      outcome,
    };
  }
  const hasDuration =
    lastDurationMs !== null &&
    Number.isFinite(lastDurationMs) &&
    lastDurationMs > 0;
  let smoothedDurationMs = state.smoothedDurationMs;
  if (hasDuration) {
    smoothedDurationMs =
      state.smoothedDurationMs === null
        ? lastDurationMs
        : 0.4 * lastDurationMs + 0.6 * state.smoothedDurationMs;
  }
  const stableBatches =
    verdict.kind === "normal" && outcome === "success" && hasDuration
      ? state.stableBatches + 1
      : 0;
  // Batch sizing after GitLab Batch::Optimizer (MIT); AIMD bounds apply to the combined step.
  const durationRatio =
    smoothedDurationMs === null
      ? 1
      : clamp(config.targetDurationMs / smoothedDurationMs, 0.5, 1.2);
  let ratio =
    durationRatio > 1 && stableBatches < config.stableBatchesBeforeGrow
      ? 1
      : durationRatio;
  if (verdict.kind === "degraded") {
    ratio = 0.5;
  }
  if (outcome === "statement_timeout") {
    ratio = verdict.kind === "degraded" ? 0.5 : 0.75;
  }
  // ceil on shrink and floor on growth preserve the ratio even for small integer batches.
  const size = clamp(
    ratio < 1 ? Math.ceil(state.size * ratio) : Math.floor(state.size * ratio),
    config.minSize,
    config.maxSize,
  );
  const sleepMs = clamp(
    verdict.kind === "degraded" ? state.sleepMs * 2 : state.sleepMs / 2,
    config.minSleepMs,
    config.maxSleepMs,
  );
  const nextState: BatchState = {
    size,
    sleepMs,
    smoothedDurationMs,
    stableBatches,
    holdCount: 0,
    heldSince: null,
    holdUntil: null,
  };
  return {
    action: "run" as const,
    size,
    sleepMs,
    state: nextState,
    verdict,
    config,
    lastDurationMs,
    outcome,
  };
};

export const isHeldTooLong = (
  state: Pick<BatchState, "heldSince">,
  now: number,
  config: HealthConfig = defaultConfig,
) => {
  validateConfig(config);
  if (state.heldSince === null || now <= state.heldSince) {
    return false;
  }
  if (config.busyWindows.length === 0) {
    return now - state.heldSince >= config.maxHeldMs;
  }
  const windows = config.busyWindows.map(({ start, end, timeZone }) => ({
    start,
    end,
    formatter: new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }),
  }));
  let eligibleMs = 0;
  // Walk instant minutes: repeated and missing local minutes on DST days then
  // retain their actual elapsed duration, and overlapping windows count once.
  for (let cursor = state.heldSince; cursor < now;) {
    const minuteEnd = Math.min(now, (Math.floor(cursor / 60_000) + 1) * 60_000);
    const busy = windows.some(({ start, end, formatter }) => {
      const parts = formatter.formatToParts(cursor);
      const hour = parts.find(({ type }) => type === "hour")?.value;
      const minute = parts.find(({ type }) => type === "minute")?.value;
      const local = `${hour}:${minute}`;
      return start < end
        ? local >= start && local < end
        : local >= start || local < end;
    });
    if (!busy) {
      eligibleMs += minuteEnd - cursor;
      if (eligibleMs >= config.maxHeldMs) {
        return true;
      }
    }
    cursor = minuteEnd;
  }
  return false;
};
