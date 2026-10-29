import { Result } from "better-result";
import { sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import { caseLawCoverageSummaries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readNonRedistributableCaseLawSourceIdsQuery } from "@/api/lib/case-law/non-redistributable-sources";
import { lockCaseLawCoverageSnapshot } from "@/api/lib/db/aggregate-lock";
import {
  logSchedulerBackfillStatus,
  SCHEDULER_BACKFILL_CONFIG,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_CASE_LAW_COVERAGE_TASK =
  "caseLaw.refreshCoverage" as const;

/** One admitted summary refresh per run; a failed refresh retains the old answer. */
export const CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS = 30_000;
const REFRESH_RUN_BUDGET_MS = 60_000;

type CoverageRefreshBatch = {
  cursor: null;
  done: boolean;
  value: Result<string, SchedulerTaskFailure>;
};

/** Maintenance reads use the root transaction already held by the refresh. */
type CoverageRefreshReadDb = <T>(
  read: (tx: Pick<Transaction, "execute" | "select">) => Promise<T>,
) => Promise<T>;

type CoverageRefreshOptions = {
  createRuntime?: typeof createScriptBackfillRuntime;
  compute: (
    readDb: CoverageRefreshReadDb,
    excludedSourceIds: readonly SafeId<"caseLawSource">[],
  ) => Promise<{
    complete: boolean;
    answer:
      | { generatedAt: string; countries: readonly unknown[] }
      | { message: string };
  }>;
};

export const createCaseLawCoverageRefreshTask =
  ({
    createRuntime = createScriptBackfillRuntime,
    compute,
  }: CoverageRefreshOptions): SchedulerTask =>
  async ({ db, logger, runId, signal }) => {
    signal.throwIfAborted();
    const refreshSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(REFRESH_RUN_BUDGET_MS),
    ]);
    const runtime = createRuntime({
      db,
      name: SCHEDULER_BACKFILL_IDS.coverage,
      tableName: "case_law_decisions",
      initialSize: 1,
      config: {
        ...SCHEDULER_BACKFILL_CONFIG,
        minSize: 1,
        maxSize: 1,
        batchStatementTimeoutMs: CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS,
      },
      observeStatus: logSchedulerBackfillStatus,
      reporting: "changes",
      statementTimeoutPolicy: "fail",
    });
    const settled = await Result.tryPromise({
      try: async () => {
        try {
          return await runtime.step(
            async ({ tx }): Promise<CoverageRefreshBatch> => {
              refreshSignal.throwIfAborted();
              await lockCaseLawCoverageSnapshot(tx);
              const policy =
                await readNonRedistributableCaseLawSourceIdsQuery(tx);
              const readState: { failure: Result<void, unknown> } = {
                failure: Result.ok(undefined),
              };
              const { answer, complete } = await compute(async (read) => {
                refreshSignal.throwIfAborted();
                if (readState.failure.isErr()) {
                  throw readState.failure.error;
                }
                const result = await Result.tryPromise({
                  try: async () => await read(tx),
                  catch: (cause) => cause,
                });
                if (result.isErr()) {
                  if (readState.failure.isOk()) {
                    readState.failure = Result.err(result.error);
                  }
                  throw readState.failure.error;
                }
                return result.value;
              }, policy);
              // Assembly can degrade a failed read; PostgreSQL cannot continue
              // its transaction. Roll back before the runtime writes a checkpoint.
              if (readState.failure.isErr()) {
                throw readState.failure.error;
              }
              refreshSignal.throwIfAborted();
              if (!complete || "message" in answer) {
                return {
                  cursor: null,
                  done: false,
                  value: Result.err(
                    new SchedulerTaskFailure({
                      message:
                        "Coverage refresh did not produce a complete answer",
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
              await tx
                .insert(caseLawCoverageSummaries)
                .values(summary)
                .onConflictDoUpdate({
                  target: caseLawCoverageSummaries.key,
                  set: summary,
                });
              await recordSystemAudit(tx, "system:case-law-coverage-refresh", {
                subject: runId,
                counts: { summaries: 1, countries: answer.countries.length },
              });
              return {
                cursor: null,
                done: true,
                value: Result.ok(answer.generatedAt),
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
    logger.info("scheduler.case_law_coverage_refreshed", {
      "caseLawCoverage.generatedAt": settled.value.value.value,
    });
    return undefined;
  };

/** Removal retires the cached answer before its next governed refresh. */
export const invalidateCaseLawCoverageSummaryTx = async (
  tx: Transaction,
): Promise<void> => {
  // audit: skip — coverage invalidation belongs to the canonical removal audit.
  await tx.delete(caseLawCoverageSummaries).where(sql`true`);
};
