import { Result } from "better-result";

import { compareCodeUnit } from "@stll/collation";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import { caseLawCoverageSummaries } from "@/api/db/schema";
import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { coverageResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
import { readNonRedistributableCaseLawSourceIdsQuery } from "@/api/lib/case-law/non-redistributable-sources";
import {
  logSchedulerBackfillStatus,
  SCHEDULER_BACKFILL_CONFIG,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";
import { projectResponseText } from "@/api/lib/search/project-response-text";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_CASE_LAW_COVERAGE_TASK =
  "caseLaw.refreshCoverage" as const;

/** One admitted summary refresh per run; a failed refresh retains the old answer. */
const REFRESH_STATEMENT_TIMEOUT_MS = 30_000;
const REFRESH_RUN_BUDGET_MS = 60_000;

export const createCaseLawCoverageRefreshTask =
  ({
    createRuntime = createScriptBackfillRuntime,
    compute = computeCaseLawCoverageAnswer,
  }: {
    createRuntime?: typeof createScriptBackfillRuntime;
    compute?: typeof computeCaseLawCoverageAnswer;
  } = {}): SchedulerTask =>
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
        batchStatementTimeoutMs: REFRESH_STATEMENT_TIMEOUT_MS,
      },
      observeStatus: logSchedulerBackfillStatus,
      reporting: "changes",
      statementTimeoutPolicy: "fail",
    });
    const settled = await Result.tryPromise({
      try: async () => {
        try {
          return await runtime.step(async ({ tx }) => {
            refreshSignal.throwIfAborted();
            const policy =
              await readNonRedistributableCaseLawSourceIdsQuery(tx);
            const { answer, complete } = await compute(async (read) => {
              refreshSignal.throwIfAborted();
              return await read(tx);
            }, policy);
            refreshSignal.throwIfAborted();
            if (!complete || "message" in answer) {
              throw new SchedulerTaskFailure({
                message: "Coverage refresh did not produce a complete answer",
                cause: { complete },
              });
            }
            const summary = {
              key: "current",
              sourcePolicy: JSON.stringify(policy.toSorted(compareCodeUnit)),
              answer: projectResponseText(answer, coverageResponseSchema),
              generatedAt: new Date(answer.generatedAt),
            };
            // audit: skip — derived public summary; the refresh has a system audit below.
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
            return { cursor: null, done: true, value: answer.generatedAt };
          });
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
    logger.info("scheduler.case_law_coverage_refreshed", {
      "caseLawCoverage.generatedAt": settled.value.value,
    });
    return undefined;
  };

export const refreshCaseLawCoverageTask = createCaseLawCoverageRefreshTask();
