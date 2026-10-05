import { panic, Result } from "better-result";

import {
  initialBatchState,
  nextBatch,
  type BatchState,
  type HealthConfig,
  type Verdict,
  isHeldTooLong,
} from "@stll/db-load-gate/health";

import type { ReplayRunReport } from "@/api/handlers/case-law/ingestion/replay";
import type { SafeId } from "@/api/lib/branded-types";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

import { REPLAY_HEALTH_CONFIG } from "./replay-enrolment";
import {
  classifyReplayFailure,
  replayFailure,
  type ReplayFailure,
} from "./replay-failure";

export type BackgroundReplaySource = {
  id: SafeId<"caseLawSource">;
  adapterKey: AdapterKey;
  currentParserVersion: number;
  dailyBudget: number;
  mode: "enrolled" | "dry-run";
  rowsBehind: number;
};

export type BackgroundReplayBatch = {
  id: string;
  source: BackgroundReplaySource;
  decisionId: SafeId<"caseLawDecision">;
  parserVersionFrom: number | null;
  targetParserVersion: number;
};

export type BackgroundReplayReservation =
  | { type: "reserved"; batch: BackgroundReplayBatch }
  | { type: "budget-exhausted" }
  | { type: "empty" };

type BackgroundReplayCompletion = {
  report: ReplayRunReport;
  durationMs: number;
  verdict: Verdict;
  healthyEvidence?: "adjacent-row" | "none";
};

type BackgroundReplayTickStatus =
  | "empty"
  | "complete"
  | "held"
  | "killed"
  | "budget-exhausted"
  | "lease-unavailable"
  | "slot-unavailable"
  | "retryable"
  | "time-limit"
  | "row-limit"
  | "failed";

export type BackgroundReplayTickReport = {
  status: BackgroundReplayTickStatus;
  source: BackgroundReplaySource | null;
  attempted: number;
  applied: number;
  blocked: number;
  errors: number;
  failed: number;
  retryExhausted: number;
  retryTerminal: number;
  heldTooLong: boolean;
};

export type BackgroundReplayDependencies = {
  chooseSource: () => Promise<BackgroundReplaySource | null>;
  killRequested: (source: BackgroundReplaySource) => Promise<boolean>;
  acquireLease: (
    source: BackgroundReplaySource,
  ) => Promise<(() => Promise<void>) | null>;
  acquireHeavySlot: () => Promise<(() => Promise<void>) | null>;
  loadGateState: (source: BackgroundReplaySource) => Promise<BatchState | null>;
  saveGateState: (
    source: BackgroundReplaySource,
    state: BatchState,
  ) => Promise<void>;
  gate: () => Promise<Verdict>;
  pendingBatch: (
    source: BackgroundReplaySource,
    utcDay: string,
  ) => Promise<BackgroundReplayReservation>;
  /** Atomically reserves one row and charges its UTC day's attempted budget. */
  reserveBatch: (
    source: BackgroundReplaySource,
    utcDay: string,
  ) => Promise<BackgroundReplayReservation>;
  previewBatch: (
    source: BackgroundReplaySource,
    after: SafeId<"caseLawDecision"> | null,
  ) => Promise<BackgroundReplayReservation | { type: "waiting" }>;
  replay: (
    batch: BackgroundReplayBatch,
    options: { apply: boolean },
  ) => Promise<ReplayRunReport>;
  /** Receipt completion and cursor advancement share one short transaction. */
  completeBatch: (
    batch: BackgroundReplayBatch,
    completion: BackgroundReplayCompletion,
  ) => Promise<
    | "applied"
    | "blocked"
    | "unchanged"
    | "retryable"
    | "isolated"
    | "failed"
    | "retry-exhausted"
    | "retry-terminal"
  >;
  recordFailure: (
    batch: BackgroundReplayBatch,
    failure: ReplayFailure & {
      durationMs: number;
      verdict: Verdict;
      healthyEvidence: "adjacent-row" | "none";
    },
  ) => Promise<
    | "retryable"
    | "failed"
    | "applied"
    | "isolated"
    | "retry-exhausted"
    | "retry-terminal"
  >;
  pickUpBatch: (
    batch: BackgroundReplayBatch,
  ) => Promise<"ready" | "retry-exhausted" | "retry-terminal" | "waiting">;
  advancePreview: (batch: BackgroundReplayBatch) => Promise<void>;
  metric: (report: BackgroundReplayTickReport) => void;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

type BackgroundReplayTickOptions = {
  dependencies: BackgroundReplayDependencies;
  maxRows: number;
  maxDurationMs: number;
  healthConfig?: HealthConfig;
  signal?: AbortSignal;
};

type AdmitReplayBatchOptions = {
  source: BackgroundReplaySource;
  dependencies: BackgroundReplayDependencies;
  after: SafeId<"caseLawDecision"> | null;
  stopRequested: () => Promise<"killed" | "time-limit" | null>;
};

type ReplayAdmission =
  | BackgroundReplayReservation
  | {
      type: "stopped";
      status: "killed" | "time-limit" | "retryable";
    };

/** Resume durable work before inspecting current parser lag or reserving new work. */
const admitReplayBatch = async ({
  source,
  dependencies,
  after,
  stopRequested,
}: AdmitReplayBatchOptions): Promise<ReplayAdmission> => {
  if (source.mode === "dry-run") {
    const preview = await dependencies.previewBatch(source, after);
    return preview.type === "waiting"
      ? { type: "stopped", status: "retryable" }
      : preview;
  }
  const utcDay = new Date(dependencies.now()).toISOString().slice(0, 10);
  const pending = await dependencies.pendingBatch(source, utcDay);
  const stopped = await stopRequested();
  if (stopped !== null) {
    return { type: "stopped", status: stopped };
  }
  switch (pending.type) {
    case "reserved":
    case "budget-exhausted":
      return pending;
    case "empty":
      return await dependencies.reserveBatch(source, utcDay);
    default:
      pending satisfies never;
      return panic("Unhandled replay reservation");
  }
};

type ReplayLoopOptions = {
  dependencies: BackgroundReplayDependencies;
  source: BackgroundReplaySource;
  report: BackgroundReplayTickReport;
  finish: (status: BackgroundReplayTickStatus) => BackgroundReplayTickReport;
  start: number;
  rowLimit: number;
  maxRows: number;
  maxDurationMs: number;
  healthConfig: HealthConfig;
  signal: AbortSignal | undefined;
};

type LoadReplayGateOptions = {
  dependencies: BackgroundReplayDependencies;
  source: BackgroundReplaySource;
  config: HealthConfig;
};

const loadReplayGate = async ({
  dependencies,
  source,
  config,
}: LoadReplayGateOptions) => {
  if (source.mode === "dry-run") {
    return initialBatchState(config);
  }
  return (
    (await dependencies.loadGateState(source)) ?? initialBatchState(config)
  );
};

type RunReplayBatchOptions = {
  dependencies: BackgroundReplayDependencies;
  source: BackgroundReplaySource;
  batch: BackgroundReplayBatch;
  report: BackgroundReplayTickReport;
  verdict: Verdict;
  signal: AbortSignal | undefined;
};

type ReplayFailureStopOptions = {
  mode: BackgroundReplaySource["mode"];
  code: ReplayFailure["code"];
  scope: ReplayFailure["scope"];
};
const replayFailureStop = ({ mode, code, scope }: ReplayFailureStopOptions) => {
  if (scope === "systemic") {
    return code === "tick-deadline" ? "time-limit" : "failed";
  }
  return mode === "dry-run" ? "retryable" : null;
};

const countFailedOutcome = (
  outcome: Awaited<ReturnType<BackgroundReplayDependencies["completeBatch"]>>,
  report: BackgroundReplayTickReport,
) => {
  const failed =
    outcome === "failed" ||
    outcome === "retry-exhausted" ||
    outcome === "retry-terminal";
  report.failed += Number(failed);
  report.retryExhausted += Number(outcome === "retry-exhausted");
  report.retryTerminal += Number(outcome === "retry-terminal");
  return failed;
};

type SettleReplayFailureOptions = Omit<RunReplayBatchOptions, "signal"> & {
  failure: ReplayFailure;
  durationMs: number;
};

/** Records a batch failure and says whether the tick stops on it. */
const settleReplayFailure = async ({
  dependencies,
  source,
  batch,
  report,
  verdict,
  failure,
  durationMs,
}: SettleReplayFailureOptions) => {
  report.errors += 1;
  const settlement = await Result.tryPromise(
    async () =>
      await dependencies.recordFailure(batch, {
        ...failure,
        durationMs,
        verdict,
        healthyEvidence: report.applied > 0 ? "adjacent-row" : "none",
      }),
  );
  if (settlement.isErr()) {
    return "failed" as const;
  }
  const failed = countFailedOutcome(settlement.value, report);
  report.applied += Number(settlement.value === "applied");
  if (
    settlement.value === "failed" ||
    settlement.value === "retry-exhausted" ||
    settlement.value === "retry-terminal"
  ) {
    return null;
  }
  return replayFailureStop({
    mode: source.mode,
    code: failure.code,
    scope: settlement.value === "isolated" || failed ? "row" : failure.scope,
  });
};

const runReplayBatch = async ({
  dependencies,
  source,
  batch,
  report,
  verdict,
  signal,
}: RunReplayBatchOptions) => {
  const started = dependencies.now();
  const attempt = await Result.tryPromise({
    try: async () =>
      await dependencies.replay(batch, { apply: source.mode === "enrolled" }),
    catch: (cause) => cause,
  });
  const durationMs = Math.max(0, dependencies.now() - started);
  report.attempted += 1;
  const replayed = attempt.isOk() ? attempt.value : null;
  const rowErrors =
    replayed === null
      ? 1
      : replayed.outcomes.retryable + replayed.outcomes["withdraw-incomplete"];
  let failure = replayed?.failure ?? null;
  if (signal?.aborted) {
    failure = replayFailure("tick-deadline");
  } else if (attempt.isErr()) {
    failure = classifyReplayFailure(attempt.error);
  } else if (
    failure === null &&
    (rowErrors > 0 || replayed?.haltReason !== null)
  ) {
    failure = replayFailure("writer-retryable");
  }
  let stop: "failed" | "time-limit" | "retryable" | null = null;
  if (failure === null && source.mode === "enrolled" && replayed !== null) {
    const completion = await Result.tryPromise(
      async () =>
        await dependencies.completeBatch(batch, {
          report: replayed,
          durationMs,
          verdict,
          healthyEvidence: report.applied > 0 ? "adjacent-row" : "none",
        }),
    );
    if (completion.isOk()) {
      report.applied += Number(completion.value === "applied");
      report.blocked += Number(completion.value === "blocked");
      const failed = countFailedOutcome(completion.value, report);
      report.errors += Number(
        completion.value === "retryable" ||
          completion.value === "isolated" ||
          failed,
      );
      if (completion.value === "retryable") {
        stop = "failed";
      }
    } else {
      failure = replayFailure(
        signal?.aborted ? "tick-deadline" : "receipt-write",
      );
    }
  }
  if (failure !== null) {
    // A failure path never set `stop` above: completion only stops on success.
    stop = await settleReplayFailure({
      dependencies,
      source,
      batch,
      report,
      verdict,
      failure,
      durationMs,
    });
  }
  if (source.mode === "dry-run" && failure === null) {
    await dependencies.advancePreview(batch);
  }
  return { durationMs, stop };
};

type ReplayPickupOptions = {
  dependencies: BackgroundReplayDependencies;
  batch: BackgroundReplayBatch;
  stopRequested: () => Promise<"killed" | "time-limit" | null>;
  signal: AbortSignal | undefined;
  verdict: Verdict;
};

const pickUpReplayBatch = async ({
  dependencies,
  batch,
  stopRequested,
  signal,
  verdict,
}: ReplayPickupOptions) => {
  const pickedUp = await dependencies.pickUpBatch(batch);
  if (pickedUp === "waiting") {
    return { type: "stopped", status: "retryable" } as const;
  }
  if (pickedUp === "retry-exhausted" || pickedUp === "retry-terminal") {
    return { type: "failed", outcome: pickedUp } as const;
  }
  const afterPickup = await stopRequested();
  if (afterPickup === null) {
    return { type: "ready" } as const;
  }
  const cancelled = await Result.tryPromise(
    async () =>
      await dependencies.recordFailure(batch, {
        ...replayFailure(signal?.aborted ? "tick-deadline" : "tick-cancelled"),
        durationMs: 0,
        verdict,
        healthyEvidence: "none",
      }),
  );
  return {
    type: "stopped",
    status: cancelled.isErr() ? "failed" : afterPickup,
  } as const;
};

/** Each batch owns a session slot across remote I/O and yields it before pacing. */
const runReplayLoop = async ({
  dependencies,
  source,
  report,
  finish,
  start,
  rowLimit,
  maxRows,
  maxDurationMs,
  healthConfig,
  signal,
}: ReplayLoopOptions): Promise<BackgroundReplayTickReport> => {
  let releaseSlot: (() => Promise<void>) | null = null;
  try {
    const config = { ...healthConfig, minSize: 1, maxSize: 1 };
    let state = await loadReplayGate({ dependencies, source, config });
    let lastDurationMs: number | null = null;
    let after: SafeId<"caseLawDecision"> | null = null;
    const stopRequested = async () => {
      if (signal?.aborted) {
        return "time-limit" as const;
      }
      if (await dependencies.killRequested(source)) {
        return "killed" as const;
      }
      return dependencies.now() - start >= maxDurationMs
        ? ("time-limit" as const)
        : null;
    };
    while (report.attempted < rowLimit) {
      const beforeHealth = await stopRequested();
      if (beforeHealth !== null) {
        return finish(beforeHealth);
      }
      if (state.holdUntil !== null && dependencies.now() < state.holdUntil) {
        report.heldTooLong = isHeldTooLong(
          state,
          dependencies.now(),
          healthConfig,
        );
        return finish("held");
      }
      const readVerdict = await Result.tryPromise(dependencies.gate);
      const verdict = readVerdict.isOk()
        ? readVerdict.value
        : ({ kind: "unknown", signals: [] } satisfies Verdict);
      const plan = nextBatch({
        state,
        verdict,
        lastDurationMs,
        config,
        clock: dependencies.now,
      });
      state = plan.state;
      if (source.mode === "enrolled") {
        await dependencies.saveGateState(source, state);
      }
      if (plan.action === "hold") {
        report.heldTooLong = isHeldTooLong(
          state,
          dependencies.now(),
          healthConfig,
        );
        return finish("held");
      }
      // A kill flipped during health I/O must not reserve another row.
      const afterHealth = await stopRequested();
      if (afterHealth !== null) {
        return finish(afterHealth);
      }
      if (source.mode === "enrolled") {
        releaseSlot = await dependencies.acquireHeavySlot();
        if (releaseSlot === null) {
          return finish("slot-unavailable");
        }
      }
      const afterSlot = await stopRequested();
      if (afterSlot !== null) {
        return finish(afterSlot);
      }
      const admission = await admitReplayBatch({
        source,
        dependencies,
        after,
        stopRequested,
      });
      if (admission.type === "stopped") {
        return finish(admission.status);
      }
      if (admission.type === "budget-exhausted") {
        return finish("budget-exhausted");
      }
      if (admission.type === "empty") {
        return finish("complete");
      }
      const batch = admission.batch;
      const afterAdmission = await stopRequested();
      if (afterAdmission !== null) {
        return finish(afterAdmission);
      }
      if (source.mode === "enrolled") {
        const pickedUp = await pickUpReplayBatch({
          dependencies,
          batch,
          stopRequested,
          signal,
          verdict,
        });
        if (pickedUp.type === "stopped") {
          return finish(pickedUp.status);
        }
        if (pickedUp.type === "failed") {
          report.attempted += 1;
          countFailedOutcome(pickedUp.outcome, report);
          report.errors += 1;
          await releaseSlot?.();
          releaseSlot = null;
          after = batch.decisionId;
          continue;
        }
      }
      const replayResult = await runReplayBatch({
        dependencies,
        source,
        batch,
        report,
        verdict,
        signal,
      });
      lastDurationMs = replayResult.durationMs;
      await releaseSlot?.();
      releaseSlot = null;
      if (replayResult.stop !== null) {
        return finish(replayResult.stop);
      }
      after = batch.decisionId;
      const afterReplay = await stopRequested();
      if (afterReplay !== null) {
        return finish(afterReplay);
      }
      if (report.attempted >= rowLimit) {
        return finish(
          source.mode === "enrolled" && source.dailyBudget < maxRows
            ? "budget-exhausted"
            : "row-limit",
        );
      }
      if (plan.sleepMs > 0) {
        if (dependencies.now() - start + plan.sleepMs >= maxDurationMs) {
          return finish("time-limit");
        }
        await dependencies.sleep(plan.sleepMs);
      }
    }
    return finish("row-limit");
  } finally {
    await releaseSlot?.();
  }
};

/** One decision per batch bounds interruption, reservation, and budget accounting. */
export const runBackgroundReplayTick = async ({
  dependencies,
  maxRows,
  maxDurationMs,
  healthConfig = REPLAY_HEALTH_CONFIG,
  signal,
}: BackgroundReplayTickOptions): Promise<BackgroundReplayTickReport> => {
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    !Number.isFinite(maxDurationMs) ||
    maxDurationMs <= 0
  ) {
    panic("Replay tick bounds must be positive");
  }
  const start = dependencies.now();
  const admission = signal?.aborted
    ? Result.err(signal.reason)
    : await Result.tryPromise(dependencies.gate);
  if (signal?.aborted) {
    const report: BackgroundReplayTickReport = {
      status: "time-limit",
      source: null,
      attempted: 0,
      applied: 0,
      blocked: 0,
      errors: 0,
      failed: 0,
      retryExhausted: 0,
      retryTerminal: 0,
      heldTooLong: false,
    };
    dependencies.metric(report);
    return report;
  }
  if (
    admission.isErr() ||
    (admission.value.kind !== "normal" && admission.value.kind !== "degraded")
  ) {
    const report: BackgroundReplayTickReport = {
      status: "held",
      source: null,
      attempted: 0,
      applied: 0,
      blocked: 0,
      errors: 0,
      failed: 0,
      retryExhausted: 0,
      retryTerminal: 0,
      heldTooLong: false,
    };
    dependencies.metric(report);
    return report;
  }
  const source = await dependencies.chooseSource();
  const report: BackgroundReplayTickReport = {
    status: "empty",
    source,
    attempted: 0,
    applied: 0,
    blocked: 0,
    errors: 0,
    failed: 0,
    retryExhausted: 0,
    retryTerminal: 0,
    heldTooLong: false,
  };
  const finish = (status: BackgroundReplayTickStatus) => {
    report.status = status;
    dependencies.metric(report);
    return report;
  };
  if (source === null) {
    return finish("empty");
  }
  const rowLimit = Math.min(maxRows, source.dailyBudget);
  if (!Number.isSafeInteger(source.dailyBudget) || source.dailyBudget < 1) {
    panic("Replay source daily budget must be a positive integer");
  }
  if (await dependencies.killRequested(source)) {
    return finish("killed");
  }

  const held = await dependencies.loadGateState(source);
  if (
    held?.holdUntil !== null &&
    held?.holdUntil !== undefined &&
    dependencies.now() < held.holdUntil
  ) {
    report.heldTooLong = isHeldTooLong(held, dependencies.now(), healthConfig);
    return finish("held");
  }
  let releaseLease: (() => Promise<void>) | null = null;
  try {
    if (source.mode === "enrolled") {
      releaseLease = await dependencies.acquireLease(source);
      if (releaseLease === null) {
        return finish("lease-unavailable");
      }
    }
    return await runReplayLoop({
      dependencies,
      source,
      report,
      finish,
      start,
      rowLimit,
      maxRows,
      maxDurationMs,
      healthConfig,
      signal,
    });
  } finally {
    await releaseLease?.();
  }
};
