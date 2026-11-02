import { Err, panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import type { HealthConfig } from "@stll/db-load-gate/health";

import {
  BACKFILL_TABLE_CONTENTION,
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import { caseLawCoverageSummaries } from "@/api/db/schema";
import { loadGateHealthConfig } from "@/api/env-online-index";
import type { SafeId } from "@/api/lib/branded-types";
import { CASE_LAW_COVERAGE_CURRENT_WITHIN_MS } from "@/api/lib/case-law/coverage-freshness";
import type { CaseLawCoveragePart } from "@/api/lib/case-law/coverage-parts";
import { CASE_LAW_COVERAGE_REFRESH_INTERVAL_MS } from "@/api/lib/case-law/coverage-refresh-interval";
import { readNonRedistributableCaseLawSourceIdsQuery } from "@/api/lib/case-law/non-redistributable-sources";
import {
  lockCaseLawCoverageSnapshot,
  withAggregateSavepoint,
} from "@/api/lib/db/aggregate-lock";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import {
  logSchedulerBackfillStatus,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_CASE_LAW_COVERAGE_TASK =
  "caseLaw.refreshCoverage" as const;

/**
 * One admitted summary refresh per run. A read that fails or outlasts its
 * statement leaves only its own part unread; the rest of the answer is still
 * read and stored, naming the parts it lacks.
 */
export const CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS = 30_000;
/** Reads not started within the run's budget are left unread, not waited on. */
export const CASE_LAW_COVERAGE_REFRESH_RUN_BUDGET_MS = 60_000;

/**
 * The refresh reads the corpus under shared locks and writes only its own
 * summary row, so it is governed as a reader rather than a corpus writer:
 * the shared IO balance and the configured busy windows hold it at the
 * configured floors, and a
 * hold never outlasts one refresh interval, so the next scheduled run always
 * re-reads the load instead of sitting out a backoff it no longer needs. It
 * still takes the shared backfill slot, so it never runs beside a backfill.
 */
export const caseLawCoverageRefreshConfig = (
  health: HealthConfig = loadGateHealthConfig(),
): HealthConfig => ({
  ...health,
  minSize: 1,
  maxSize: 1,
  batchStatementTimeoutMs: CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS,
  holdBackoffCapMs: CASE_LAW_COVERAGE_REFRESH_INTERVAL_MS,
});

type CoverageRefreshOutcome =
  | { type: "stored"; generatedAt: string; unreadParts: readonly string[] }
  /** A partial answer never displaces a complete one that is still current. */
  | { type: "kept-current-complete"; unreadParts: readonly string[] };

type CoverageRefreshBatch = {
  cursor: null;
  done: boolean;
  value: Result<CoverageRefreshOutcome, SchedulerTaskFailure>;
};

/**
 * Maintenance reads use the root transaction already held by the refresh,
 * each in its own savepoint: a read that fails rejects, and the transaction
 * stays usable for the reads after it.
 */
type CoverageRefreshReadDb = <T>(
  read: (tx: Pick<Transaction, "execute" | "select">) => Promise<T>,
) => Promise<T>;

type CoverageRefreshOptions = {
  createRuntime?: typeof createScriptBackfillRuntime;
  /** Overrides the run's read budget; tests spend it without waiting. */
  readBudget?: () => AbortSignal;
  compute: (
    readDb: CoverageRefreshReadDb,
    excludedSourceIds: readonly SafeId<"caseLawSource">[],
  ) => Promise<{
    complete: boolean;
    answer:
      | {
          generatedAt: string;
          unreadParts: readonly CaseLawCoveragePart[];
          countries: readonly unknown[];
        }
      | { message: string };
  }>;
};

/** A read the refresh did not start because its budget was spent. */
class CoverageReadBudgetSpentError extends Error {
  override name = "CoverageReadBudgetSpentError";
}

/**
 * Runs each read in its own savepoint, one at a time: the connection is
 * shared, and savepoints only nest, so two reads must never interleave.
 */
const coverageReadQueue = (
  tx: Transaction,
  budget: AbortSignal,
): CoverageRefreshReadDb => {
  let tail: Promise<unknown> = Promise.resolve();
  return async <T>(
    read: (tx: Pick<Transaction, "execute" | "select">) => Promise<T>,
  ): Promise<T> => {
    const run = async (): Promise<T> => {
      if (budget.aborted) {
        return await Promise.reject(
          new CoverageReadBudgetSpentError("Coverage read budget spent"),
        );
      }
      return await withAggregateSavepoint(tx, async (savepoint) => {
        const value = await read(savepoint);
        // Some public readers return a typed failure instead of rejecting;
        // either form rolls back this read alone.
        if (value instanceof Err) {
          return abortTransaction(
            new SchedulerTaskFailure({
              message: "Case-law coverage read failed",
              cause: value.error,
            }),
          );
        }
        return value;
      });
    };
    // The next read waits for this one to settle either way; its failure is
    // this caller's to handle, not the queue's.
    const next = tail.then(run);
    tail = Promise.allSettled([next]);
    return await next;
  };
};

export const createCaseLawCoverageRefreshTask =
  ({
    createRuntime = createScriptBackfillRuntime,
    readBudget,
    compute,
  }: CoverageRefreshOptions): SchedulerTask =>
  async ({ db, logger, runId, signal }) => {
    signal.throwIfAborted();
    const budget = AbortSignal.any([
      signal,
      readBudget?.() ??
        AbortSignal.timeout(CASE_LAW_COVERAGE_REFRESH_RUN_BUDGET_MS),
    ]);
    const runtime = createRuntime({
      db,
      name: SCHEDULER_BACKFILL_IDS.coverage,
      tableName: "case_law_decisions",
      tableContention: BACKFILL_TABLE_CONTENTION.SHARED_READ,
      initialSize: 1,
      config: caseLawCoverageRefreshConfig(),
      observeStatus: logSchedulerBackfillStatus,
      reporting: "changes",
      statementTimeoutPolicy: "fail",
    });
    const settled = await Result.tryPromise({
      try: async () => {
        try {
          return await runtime.step(
            async ({ tx }): Promise<CoverageRefreshBatch> => {
              signal.throwIfAborted();
              await lockCaseLawCoverageSnapshot(tx);
              const policy =
                await readNonRedistributableCaseLawSourceIdsQuery(tx);
              const { answer, complete } = await compute(
                coverageReadQueue(tx, budget),
                policy,
              );
              // Shutdown still abandons the run; a spent budget only left
              // parts unread, which the answer names.
              signal.throwIfAborted();
              if ("message" in answer) {
                return {
                  cursor: null,
                  done: false,
                  value: Result.err(
                    new SchedulerTaskFailure({
                      message: "Coverage refresh could not read the catalogue",
                      cause: { complete },
                    }),
                  ),
                };
              }
              const summary = {
                key: "current",
                sourcePolicy: JSON.stringify(policy.toSorted(compareCodeUnit)),
                answer,
                generatedAt: new Date(answer.generatedAt),
              };
              const stored = await tx
                .insert(caseLawCoverageSummaries)
                .values(summary)
                .onConflictDoUpdate({
                  target: caseLawCoverageSummaries.key,
                  set: summary,
                  // A partial answer replaces a partial one, or a complete
                  // one too old to read as current; never a current complete
                  // one. A summary stored before unread parts were named was
                  // stored complete.
                  ...(complete
                    ? {}
                    : {
                        setWhere: sql`coalesce(jsonb_array_length(${caseLawCoverageSummaries.answer} -> 'unreadParts'), 0) > 0 OR ${caseLawCoverageSummaries.generatedAt} < excluded.generated_at - make_interval(secs => ${CASE_LAW_COVERAGE_CURRENT_WITHIN_MS / 1000})`,
                      }),
                })
                .returning({ key: caseLawCoverageSummaries.key });
              if (stored.length === 0) {
                return {
                  cursor: null,
                  done: true,
                  value: Result.ok({
                    type: "kept-current-complete",
                    unreadParts: answer.unreadParts,
                  }),
                };
              }
              await recordSystemAudit(tx, "system:case-law-coverage-refresh", {
                subject: runId,
                counts: {
                  summaries: 1,
                  countries: answer.countries.length,
                  unreadParts: answer.unreadParts.length,
                },
              });
              return {
                cursor: null,
                done: true,
                value: Result.ok({
                  type: "stored",
                  generatedAt: answer.generatedAt,
                  unreadParts: answer.unreadParts,
                }),
              };
            },
          );
        } finally {
          await runtime.close();
        }
      },
      catch: (cause: unknown) => cause,
    });
    if (settled.isErr()) {
      if (settled.error instanceof BackfillHeldError) {
        logger.info("scheduler.case_law_coverage_held");
        return undefined;
      }
      return Result.err(
        new SchedulerTaskFailure({
          message: "Case-law coverage refresh failed",
          cause: settled.error,
        }),
      );
    }
    if (settled.value.value.isErr()) {
      return Result.err(settled.value.value.error);
    }
    const outcome = settled.value.value.value;
    switch (outcome.type) {
      case "stored":
        logger.info("scheduler.case_law_coverage_refreshed", {
          "caseLawCoverage.generatedAt": outcome.generatedAt,
          "caseLawCoverage.unreadParts": outcome.unreadParts.join(","),
        });
        return undefined;
      case "kept-current-complete":
        logger.info("scheduler.case_law_coverage_partial_not_stored", {
          "caseLawCoverage.unreadParts": outcome.unreadParts.join(","),
        });
        return undefined;
      default:
        outcome satisfies never;
        return panic(`Unhandled coverage refresh outcome: ${String(outcome)}`);
    }
  };

/** Removal retires the cached answer before its next governed refresh. */
export const invalidateCaseLawCoverageSummaryTx = async (
  tx: Transaction,
): Promise<void> => {
  // audit: skip — coverage invalidation belongs to the canonical removal audit.
  await tx.delete(caseLawCoverageSummaries).where(sql`true`);
};
