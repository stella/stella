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
        | "isolated"
        | "too-large"
        | "publisher-gone"
        | "withdrawn"
        | "superseded-by-crawl"
        | "mirror-repair-required"
        | "waiting-for-mirror";
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
  check: () => Promise<Result<void, unknown>>;
  checkBeforeSend: () => Result<void, EuCompletionStop>;
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
    | "releaseBenign"
    | "recordTick"
    | "readSweepCursor"
  >;
  isEnabled: () => boolean | Promise<boolean>;
  readGate: () => Promise<Verdict>;
  fence: () => Promise<void>;
  requestCount: () => number;
  runRow: (
    receipt: EuCompletionReceipt,
    options: EuCompletionRowOptions,
  ) => Promise<Result<EuCompletionRowOutcome, unknown>>;
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
    case "publisher-gone":
    case "withdrawn":
    case "unchanged":
      report.unchanged++;
      break;
    case "dry-run":
      break;
    case "review-required":
    case "mirror-repair-required":
      report.reviewRequired++;
      break;
    case "too-large":
    case "failed":
      report.failed++;
      break;
    case "superseded-by-crawl":
    case "waiting-for-mirror":
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

const createCompletionChecks = (
  {
    sourceId,
    signal,
    now,
    dependencies,
  }: Pick<
    RunEuCompletionTickOptions,
    "sourceId" | "signal" | "now" | "dependencies"
  >,
  startedAt: number,
) => {
  const checkBeforeSend = () => {
    if (signal.aborted) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion cancelled",
          reason: "cancelled",
        }),
      );
    }
    if (now() - startedAt >= EU_COMPLETION_LIMITS.softDurationMs) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion reached its soft deadline",
          reason: "time-limit",
        }),
      );
    }
    return Result.ok();
  };
  const checkState = async () => {
    const stopped = checkBeforeSend();
    if (stopped.isErr()) {
      return stopped;
    }
    const controls = await dependencies.store.loadControls(sourceId);
    if (
      !(await dependencies.isEnabled()) ||
      controls.global !== "on" ||
      controls.source !== "on"
    ) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion is disabled",
          reason: "off",
        }),
      );
    }
    const sourceState = await dependencies.store.loadSourceGateState(sourceId);
    if (sourceState.holdUntil !== null && now() < sourceState.holdUntil) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion source is backing off",
          reason: "held",
        }),
      );
    }
    if ((await dependencies.readGate()).kind !== "normal") {
      return Result.err(
        new EuCompletionStop({
          message: "Completion is held by load",
          reason: "held",
        }),
      );
    }
    const fenced = await Result.tryPromise({
      try: dependencies.fence,
      catch: (error) => error,
    });
    if (fenced.isErr()) {
      return fenced;
    }
    if (signal.aborted) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion cancelled",
          reason: "cancelled",
        }),
      );
    }
    return Result.ok();
  };
  const checkImmediate = async () => {
    const stopped = checkBeforeSend();
    if (stopped.isErr()) {
      return stopped;
    }
    if (!(await dependencies.isEnabled())) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion is disabled",
          reason: "off",
        }),
      );
    }
    return await Result.tryPromise({
      try: dependencies.fence,
      catch: (error) => error,
    });
  };
  const check = async () =>
    (
      await Result.tryPromise({ try: checkImmediate, catch: (error) => error })
    ).andThen((value) => value);
  const checkAdmission = async () =>
    (
      await Result.tryPromise({
        try: checkState,
        catch: (error) => error,
      })
    ).andThen((value) => value);
  return { check, checkAdmission, checkBeforeSend };
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
  let healthyCompleted = 0;
  let eligibleAttempts = 0;
  const finish = async () => {
    report.requests = dependencies.requestCount();
    report.durationMs = Math.max(0, now() - startedAt);
    const progress = await dependencies.store.recordTick({
      sourceId,
      mode,
      healthyCompleted,
      intentionallyHeld:
        report.status === "held" ||
        report.status === "off" ||
        report.status === "approval-required" ||
        report.status === "time-limit" ||
        report.status === "cancelled" ||
        report.status === "request-budget" ||
        report.status === "byte-budget" ||
        eligibleAttempts === 0,
      counts: {
        attempted: report.attempted,
        applied: report.applied,
        unchanged: report.unchanged,
        reviewRequired: report.reviewRequired,
        failed: report.failed,
      },
    });
    report.noProgress = progress.ticksWithoutProgress;
    return report;
  };
  const { check, checkAdmission, checkBeforeSend } = createCompletionChecks(
    { sourceId, signal, now, dependencies },
    startedAt,
  );
  const admission = await checkAdmission();
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
  for (const [index, receipt] of rows.entries()) {
    const admitted = index === 0 ? await check() : await checkAdmission();
    if (admitted.isErr()) {
      report.status =
        admitted.error instanceof EuCompletionStop
          ? admitted.error.reason
          : "failed";
      break;
    }
    // db-await-in-loop: Each row is picked up just before its paced publisher request; rows are processed one at a time at 1 request per second, bounded by maxRows.
    const pickedUp = await dependencies.store.pickup(receipt.id);
    if (pickedUp === "waiting") {
      continue;
    }
    report.attempted++;
    if (pickedUp === "failed") {
      report.failed++;
      continue;
    }
    const healthyEvidence = healthyCompleted > 0 ? "adjacent-row" : "none";
    const attempted = await Result.tryPromise({
      try: async () =>
        await dependencies.runRow(receipt, {
          check,
          checkBeforeSend,
          healthyEvidence,
        }),
      catch: (error) => error,
    });
    const result = attempted.andThen((value) => value);
    let outcome: EuCompletionRowOutcome;
    if (result.isErr()) {
      const stopped =
        result.error instanceof EuCompletionStop ? result.error : null;
      if (stopped !== null && stopped.reason !== "publisher-refused") {
        // db-await-in-loop: A stopped row is released before the walk ends; the paced walk is bounded by maxRows.
        await dependencies.store.releaseBenign(receipt.id);
        outcome = { type: "stopped", reason: stopped.reason };
      } else {
        // db-await-in-loop: A failed row settles before the next paced request so its hold applies to that request; bounded by maxRows.
        const settlement = await dependencies.store.recordFailure(receipt, {
          scope: "systemic",
          code: "unexpected",
          healthyEvidence,
        });
        outcome = { type: settlement };
      }
    } else {
      outcome = result.value;
    }
    if (
      outcome.type !== "waiting-for-mirror" &&
      outcome.type !== "mirror-repair-required" &&
      outcome.type !== "withdrawn" &&
      outcome.type !== "superseded-by-crawl"
    ) {
      eligibleAttempts++;
    }
    if (
      [
        "applied",
        "unchanged",
        "dry-run",
        "review-required",
        "publisher-gone",
        "too-large",
      ].includes(outcome.type)
    ) {
      healthyCompleted++;
    }
    recordOutcome(report, outcome);
    if (report.status !== "completed") {
      break;
    }
  }
  return await finish();
};
