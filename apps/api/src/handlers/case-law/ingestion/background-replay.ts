import { panic } from "better-result";

import {
  defaultConfig,
  initialBatchState,
  nextBatch,
  type BatchState,
  type HealthConfig,
  type Verdict,
} from "@stll/db-load-gate/health";

import type { ReplayRunReport } from "@/api/handlers/case-law/ingestion/replay";
import type { SafeId } from "@/api/lib/branded-types";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

export type BackgroundReplaySource = {
  id: SafeId<"caseLawSource">;
  adapterKey: AdapterKey;
  currentParserVersion: number;
  dailyBudget: number;
  mode: "enrolled" | "dry-run";
  rowsBehind: number;
  oldestAgeMs: number;
  blockedCount: number;
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
};

export type BackgroundReplayTickStatus =
  | "empty"
  | "complete"
  | "held"
  | "killed"
  | "budget-exhausted"
  | "lease-unavailable"
  | "slot-unavailable"
  | "error-ceiling"
  | "retryable"
  | "time-limit"
  | "row-limit";

export type BackgroundReplayTickReport = {
  status: BackgroundReplayTickStatus;
  source: BackgroundReplaySource | null;
  attempted: number;
  applied: number;
  blocked: number;
  errors: number;
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
  ) => Promise<BackgroundReplayBatch | null>;
  replay: (
    batch: BackgroundReplayBatch,
    options: { apply: boolean },
  ) => Promise<ReplayRunReport>;
  /** Receipt completion and cursor advancement share one short transaction. */
  completeBatch: (
    batch: BackgroundReplayBatch,
    completion: BackgroundReplayCompletion,
  ) => Promise<void>;
  metric: (report: BackgroundReplayTickReport) => void;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

type BackgroundReplayTickOptions = {
  dependencies: BackgroundReplayDependencies;
  maxRows: number;
  maxDurationMs: number;
  errorRateCeiling: number;
  healthConfig?: HealthConfig;
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
      status: "killed" | "time-limit";
    };

/** Resume durable work before inspecting current parser lag or reserving new work. */
const admitReplayBatch = async ({
  source,
  dependencies,
  after,
  stopRequested,
}: AdmitReplayBatchOptions): Promise<ReplayAdmission> => {
  if (source.mode === "dry-run") {
    const batch = await dependencies.previewBatch(source, after);
    return batch === null ? { type: "empty" } : { type: "reserved", batch };
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
  errorRateCeiling: number;
  healthConfig: HealthConfig;
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
  errorRateCeiling,
  healthConfig,
}: ReplayLoopOptions): Promise<BackgroundReplayTickReport> => {
  let releaseSlot: (() => Promise<void>) | null = null;
  try {
    const config = { ...healthConfig, minSize: 1, maxSize: 1 };
    let state = await loadReplayGate({ dependencies, source, config });
    let lastDurationMs: number | null = null;
    let after: SafeId<"caseLawDecision"> | null = null;
    const stopRequested = async () => {
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
        return finish("held");
      }
      const verdict = await dependencies.gate();
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
      const batchStart = dependencies.now();
      const replayed = await dependencies.replay(batch, {
        apply: source.mode === "enrolled",
      });
      lastDurationMs = Math.max(0, dependencies.now() - batchStart);
      report.attempted += 1;
      report.applied += replayed.outcomes.applied;
      report.blocked +=
        replayed.outcomes.rejected + replayed.outcomes["missing-payload"];
      const rowErrors =
        replayed.outcomes.retryable + replayed.outcomes["withdraw-incomplete"];
      report.errors += Math.max(
        rowErrors,
        replayed.haltReason === null ? 0 : 1,
      );
      // Retryable work keeps its charged reservation for the next tick.
      if (
        source.mode === "enrolled" &&
        rowErrors === 0 &&
        replayed.haltReason === null
      ) {
        await dependencies.completeBatch(batch, {
          report: replayed,
          durationMs: lastDurationMs,
          verdict,
        });
      }
      await releaseSlot?.();
      releaseSlot = null;
      after = batch.decisionId;
      if (replayed.haltReason !== null) {
        return finish("error-ceiling");
      }
      if (
        report.errors > 0 &&
        report.errors / report.attempted >= errorRateCeiling
      ) {
        return finish("error-ceiling");
      }
      if (rowErrors > 0) {
        return finish("retryable");
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
  errorRateCeiling,
  healthConfig = defaultConfig,
}: BackgroundReplayTickOptions): Promise<BackgroundReplayTickReport> => {
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    !Number.isFinite(maxDurationMs) ||
    maxDurationMs <= 0 ||
    !Number.isFinite(errorRateCeiling) ||
    errorRateCeiling < 0 ||
    errorRateCeiling > 1
  ) {
    panic(
      "Replay tick bounds must be positive, with an error ceiling between zero and one",
    );
  }
  const start = dependencies.now();
  const source = await dependencies.chooseSource();
  const report: BackgroundReplayTickReport = {
    status: "empty",
    source,
    attempted: 0,
    applied: 0,
    blocked: 0,
    errors: 0,
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
      errorRateCeiling,
      healthConfig,
    });
  } finally {
    await releaseLease?.();
  }
};
