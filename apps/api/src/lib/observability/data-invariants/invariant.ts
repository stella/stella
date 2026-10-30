/**
 * Data-correctness invariants: checks over what a pipeline produced, not over
 * whether it threw.
 *
 * Error monitoring sees a pipeline that fails. It cannot see one that
 * succeeds at producing nothing: a list that loaded empty, a screening that
 * stopped part way through every list, a source that ingests zero decisions a
 * day, or a shadow comparison made against no dictionary. Each of those
 * returns normally, so each needs a statement of what correct output looks
 * like, checked on a schedule and emitted where an alarm can read it.
 *
 * An invariant names its owner and severity, and its check reads recent
 * outputs or database aggregates and returns a verdict. The runner emits every
 * verdict as one EMF line (`DataInvariantUnhealthy`, 0 or 1, dimensioned by
 * invariant and severity) plus structured log records. A check that cannot run
 * is reported as unhealthy and observed as a failure: an invariant nobody could
 * evaluate has not held.
 */

import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { emitDataInvariantMetric } from "@/api/lib/observability/request-metrics";

/**
 * Every invariant this build checks, as stable ids: they are EMF dimension
 * values, so an alarm keyed on one keeps working across releases.
 */
export const DATA_INVARIANT_ID = {
  sanctionsListsLoaded: "sanctions.lists_loaded",
  sanctionsScreeningCompleteness: "sanctions.screening_completeness",
  caseLawIngestionDailyBand: "case_law.ingestion_daily_band",
  caseLawSearchCanaries: "case_law.search_canaries",
  queryExpansionDictionaries: "legal_search.expansion_dictionaries",
} as const;

export type DataInvariantId =
  (typeof DATA_INVARIANT_ID)[keyof typeof DATA_INVARIANT_ID];

/** The slice that answers for an invariant's subject. */
type DataInvariantOwner = "sanctions" | "case-law-ingestion" | "legal-search";

/**
 * `critical`: output a user relies on is wrong now. `warning`: output is
 * degraded or a rollout is measuring nothing.
 */
type DataInvariantSeverity = "warning" | "critical";

/** One subject that broke an invariant. */
export type DataInvariantFinding<Reason extends string> = {
  /** A list, source or canary id an operator acts on; never tenant data. */
  target: string;
  reason: Reason;
  observed: number | null;
  /** The bound the observation broke, as an operator reads it. */
  expected: string;
};

type Findings<Reason extends string> = readonly [
  DataInvariantFinding<Reason>,
  ...DataInvariantFinding<Reason>[],
];

/** Why an invariant had nothing to check on this deployment. */
type DataInvariantSkipReason = "not-configured" | "feature-off";

export type DataInvariantVerdict<Reason extends string> =
  | { status: "held"; checked: number }
  | { status: "violated"; checked: number; findings: Findings<Reason> }
  | { status: "skipped"; reason: DataInvariantSkipReason };

/** Held when nothing broke, violated otherwise; `checked` counts subjects. */
export const judgeDataInvariant = <Reason extends string>(
  checked: number,
  findings: readonly DataInvariantFinding<Reason>[],
): DataInvariantVerdict<Reason> => {
  const [first, ...rest] = findings;
  return first === undefined
    ? { status: "held", checked }
    : { status: "violated", checked, findings: [first, ...rest] };
};

type DataInvariantContext = {
  /** The run's claim instant: every window an invariant reads ends here. */
  now: Date;
  signal: AbortSignal;
};

/**
 * A read handle for aggregate checks. The scheduler passes its system
 * connection; tests pass a seeded database.
 */
export type DataInvariantReadDb = <T>(
  read: (tx: Pick<Transaction, "select">) => Promise<T>,
) => Promise<T>;

export type DataInvariant<
  Reason extends string = string,
  Id extends DataInvariantId = DataInvariantId,
> = {
  id: Id;
  owner: DataInvariantOwner;
  severity: DataInvariantSeverity;
  check: (
    context: DataInvariantContext,
  ) => Promise<DataInvariantVerdict<Reason>>;
};

export type DataInvariantOutcome =
  DataInvariantVerdict<string> | { status: "errored" };

type DataInvariantReport = {
  id: DataInvariantId;
  outcome: DataInvariantOutcome;
};

/** Per-finding log records per run; the EMF line still carries the total. */
export const MAX_LOGGED_FINDINGS = 16;

const CHECK_FAILED_SINK = failureSink({
  event: "data_invariant.check_failed",
  expected: [],
});

const invariantAttributes = (invariant: DataInvariant) => ({
  "invariant.id": invariant.id,
  "invariant.owner": invariant.owner,
  "invariant.severity": invariant.severity,
});

type EvaluatedOutcome = Omit<
  Parameters<typeof emitDataInvariantMetric>[0],
  "invariant" | "owner" | "severity"
>;

const emitMetric = (invariant: DataInvariant, outcome: EvaluatedOutcome) => {
  emitDataInvariantMetric({
    invariant: invariant.id,
    owner: invariant.owner,
    severity: invariant.severity,
    ...outcome,
  });
};

const publishOutcome = (
  invariant: DataInvariant,
  outcome: DataInvariantOutcome,
): void => {
  switch (outcome.status) {
    case "held":
      emitMetric(invariant, {
        status: "held",
        checked: outcome.checked,
        findings: 0,
      });
      logger.info("data_invariant.held", {
        ...invariantAttributes(invariant),
        "invariant.checked": outcome.checked,
      });
      return;
    case "violated": {
      emitMetric(invariant, {
        status: "violated",
        checked: outcome.checked,
        findings: outcome.findings.length,
      });
      const log =
        invariant.severity === "critical" ? logger.error : logger.warn;
      for (const finding of outcome.findings.slice(0, MAX_LOGGED_FINDINGS)) {
        log("data_invariant.violated", {
          ...invariantAttributes(invariant),
          "invariant.checked": outcome.checked,
          "invariant.findings": outcome.findings.length,
          "finding.target": finding.target,
          "finding.reason": finding.reason,
          "finding.observed": finding.observed ?? "none",
          "finding.expected": finding.expected,
        });
      }
      return;
    }
    case "skipped":
      logger.info("data_invariant.skipped", {
        ...invariantAttributes(invariant),
        "invariant.skip_reason": outcome.reason,
      });
      return;
    case "errored":
      emitMetric(invariant, {
        status: "errored",
        checked: 0,
        findings: 0,
      });
      return;
    default:
      outcome satisfies never;
      panic(`Unhandled invariant outcome: ${String(outcome)}`);
  }
};

/**
 * Check every invariant in turn and publish each verdict. Sequential, so one
 * run holds at most one aggregate read open; a check that fails is observed
 * and published as `errored`, and the rest still run.
 */
export const runDataInvariants = async (
  invariants: readonly DataInvariant[],
  context: DataInvariantContext,
): Promise<readonly DataInvariantReport[]> => {
  const reports: DataInvariantReport[] = [];
  for (const invariant of invariants) {
    context.signal.throwIfAborted();
    const checked = await Result.tryPromise(
      async () => await invariant.check(context),
    );
    if (checked.isErr()) {
      // An aborted run is the scheduler's to report, not a broken check.
      context.signal.throwIfAborted();
      observeFailure(checked.error, {
        sink: CHECK_FAILED_SINK,
        ctx: { operation: invariant.id },
      });
    }
    const outcome: DataInvariantOutcome = checked.isOk()
      ? checked.value
      : { status: "errored" };
    publishOutcome(invariant, outcome);
    reports.push({ id: invariant.id, outcome });
  }
  return reports;
};
