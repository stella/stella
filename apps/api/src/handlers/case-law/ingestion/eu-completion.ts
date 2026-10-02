import { panic, Result, TaggedError } from "better-result";

import type { Verdict } from "@stll/db-load-gate/health";

import type { SafeId } from "@/api/lib/branded-types";

import type {
  createEuCompletionStore,
  EuCompletionReceipt,
} from "./eu-completion-store";

export const EU_COMPLETION_LIMITS = {
  maxRows: 100,
  softDurationMs: 4 * 60_000,
  hardDurationMs: 5 * 60_000,
  maxRequests: 3600,
  maxBytes: 16 * 1024 * 1024,
} as const;

type CompletionStopReason =
  | "off"
  | "held"
  | "time-limit"
  | "request-budget"
  | "byte-budget"
  | "publisher-refused"
  | "cancelled";
export class EuCompletionStop extends TaggedError("EuCompletionStop")<{
  message: string;
  reason: CompletionStopReason;
}> {}

export type EuCompletionRowOutcome =
  | {
      type:
        | "applied"
        | "unchanged"
        | "review-required"
        | "dry-run"
        | "failed"
        | "retryable"
        | "isolated";
    }
  | { type: "publisher-refused"; retryAt: Date }
  | { type: "stopped"; reason: CompletionStopReason };

export type EuCompletionReport = {
  status:
    | "completed"
    | CompletionStopReason
    | "approval-required"
    | "publisher-refused"
    | "failed";
  attempted: number;
  applied: number;
  unchanged: number;
  reviewRequired: number;
  retries: number;
  failed: number;
  requests: number;
  cursorMoved: number;
  noProgress: number;
  durationMs: number;
};

export type EuCompletionRowOptions = {
  check: () => Promise<void>;
  healthyEvidence: "adjacent-row" | "none";
};

type EuCompletionDependencies = {
  store: Pick<
    ReturnType<typeof createEuCompletionStore>,
    | "loadControls"
    | "loadSourceGateState"
    | "getApproval"
    | "reserve"
    | "pickup"
    | "recordFailure"
    | "recordTick"
    | "readSweepCursor"
  >;
  isEnabled: () => Promise<boolean>;
  readGate: () => Promise<Verdict>;
  fence: () => Promise<void>;
  requestCount: () => number;
  runRow: (
    receipt: EuCompletionReceipt,
    options: EuCompletionRowOptions,
  ) => Promise<EuCompletionRowOutcome>;
};

export type RunEuCompletionTickOptions = {
  sourceId: SafeId<"caseLawSource">;
  mode: "dry-run" | "apply";
  parserVersion: number;
  maxRows: number;
  signal: AbortSignal;
  now: () => number;
  dependencies: EuCompletionDependencies;
};

const recordOutcome = (
  report: EuCompletionReport,
  outcome: EuCompletionRowOutcome,
) => {
  switch (outcome.type) {
    case "applied":
      report.applied++;
      break;
    case "unchanged":
      report.unchanged++;
      break;
    case "dry-run":
      break;
    case "review-required":
      report.reviewRequired++;
      break;
    case "failed":
      report.failed++;
      break;
    case "isolated":
      report.retries++;
      break;
    case "retryable":
      report.retries++;
      report.status = "failed";
      break;
    case "publisher-refused":
      report.status = "publisher-refused";
      break;
    case "stopped":
      report.status = outcome.reason;
      break;
    default:
      outcome satisfies never;
      panic("Unexpected completion row outcome");
  }
};

/** Every row is durably picked up before any publisher or storage work. */
export const runEuCompletionTick = async ({
  sourceId,
  mode,
  parserVersion,
  maxRows,
  signal,
  now,
  dependencies,
}: RunEuCompletionTickOptions): Promise<EuCompletionReport> => {
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > EU_COMPLETION_LIMITS.maxRows
  ) {
    panic("Completion row budget must be a bounded positive integer");
  }
  const startedAt = now();
  const report: EuCompletionReport = {
    status: "completed",
    attempted: 0,
    applied: 0,
    unchanged: 0,
    reviewRequired: 0,
    retries: 0,
    failed: 0,
    requests: 0,
    cursorMoved: 0,
    noProgress: 0,
    durationMs: 0,
  };
  const finish = async () => {
    report.requests = dependencies.requestCount();
    report.durationMs = Math.max(0, now() - startedAt);
    const progress = await dependencies.store.recordTick({
      sourceId,
      applied: report.applied,
      intentionallyHeld:
        report.status === "held" ||
        report.status === "off" ||
        report.status === "approval-required",
    });
    report.noProgress = progress.ticksWithoutProgress;
    return report;
  };
  const check = async () => {
    if (signal.aborted) {
      throw new EuCompletionStop({
        message: "Completion cancelled",
        reason: "cancelled",
      });
    }
    if (now() - startedAt >= EU_COMPLETION_LIMITS.softDurationMs) {
      throw new EuCompletionStop({
        message: "Completion reached its soft deadline",
        reason: "time-limit",
      });
    }
    const controls = await dependencies.store.loadControls(sourceId);
    if (
      !(await dependencies.isEnabled()) ||
      controls.global !== "on" ||
      controls.source !== "on"
    ) {
      throw new EuCompletionStop({
        message: "Completion is disabled",
        reason: "off",
      });
    }
    const sourceState = await dependencies.store.loadSourceGateState(sourceId);
    if (sourceState.holdUntil !== null && now() < sourceState.holdUntil) {
      throw new EuCompletionStop({
        message: "Completion source is backing off",
        reason: "held",
      });
    }
    if ((await dependencies.readGate()).kind !== "normal") {
      throw new EuCompletionStop({
        message: "Completion is held by load",
        reason: "held",
      });
    }
    await dependencies.fence();
    signal.throwIfAborted();
  };
  const admission = await Result.tryPromise({
    try: check,
    catch: (error) => error,
  });
  if (admission.isErr()) {
    report.status =
      admission.error instanceof EuCompletionStop
        ? admission.error.reason
        : "failed";
    return await finish();
  }
  if (
    mode === "apply" &&
    (await dependencies.store.getApproval({ sourceId, parserVersion })) === null
  ) {
    report.status = "approval-required";
    return await finish();
  }
  const scope = { sourceId, mode, parserVersion };
  const beforeCursor = await dependencies.store.readSweepCursor(scope);
  const rows = await dependencies.store.reserve({ ...scope, limit: maxRows });
  report.cursorMoved = Number(
    beforeCursor !== (await dependencies.store.readSweepCursor(scope)),
  );
  for (const receipt of rows) {
    const admitted = await Result.tryPromise({
      try: check,
      catch: (error) => error,
    });
    if (admitted.isErr()) {
      report.status =
        admitted.error instanceof EuCompletionStop
          ? admitted.error.reason
          : "failed";
      break;
    }
    const pickedUp = await dependencies.store.pickup(receipt.id);
    if (pickedUp === "waiting") {
      continue;
    }
    report.attempted++;
    if (pickedUp === "failed") {
      report.failed++;
      continue;
    }
    const healthyEvidence = report.applied > 0 ? "adjacent-row" : "none";
    const result = await Result.tryPromise({
      try: async () =>
        await dependencies.runRow(receipt, { check, healthyEvidence }),
      catch: (error) => error,
    });
    let outcome: EuCompletionRowOutcome;
    if (result.isErr()) {
      const stopped =
        result.error instanceof EuCompletionStop ? result.error : null;
      const settlement = await dependencies.store.recordFailure(receipt, {
        scope: "systemic",
        code: stopped === null ? "unexpected" : "cancelled",
        healthyEvidence,
      });
      outcome =
        stopped === null
          ? { type: settlement }
          : { type: "stopped", reason: stopped.reason };
    } else {
      outcome = result.value;
    }
    recordOutcome(report, outcome);
    if (report.status !== "completed") {
      break;
    }
  }
  return await finish();
};
