import { panic, Result } from "better-result";
import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { Verdict } from "@stll/db-load-gate/health";
import { sanitizeErrorAttributesForOutput } from "@stll/errors";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import { caseLawDecisions, schedulerJobs } from "@/api/db/schema";
import { readParsedInputStateBackfillEnvironment } from "@/api/env-parsed-input-state-backfill";
import { deriveCaseLawParsedInputStateBatch } from "@/api/lib/db/transitions";
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

export const BACKFILL_CASE_LAW_PARSED_INPUT_STATE_TASK =
  "caseLaw.backfillParsedInputState" as const;

const DEFAULT_PAGE_ROWS = 1000;
const CONTINUATION_DELAY_MS = 1000;

type BackfillOptions = {
  pageRows?: number;
  createRuntime?: typeof createScriptBackfillRuntime;
  readVerdict?: () => Promise<Verdict>;
  clock: () => number;
  observeStatus?: typeof logSchedulerBackfillStatus;
};

/** Historical NULLs form a fixed set: the trigger derives every later write. */
export const createCaseLawParsedInputStateBackfill =
  ({
    pageRows = DEFAULT_PAGE_ROWS,
    createRuntime = createScriptBackfillRuntime,
    readVerdict,
    clock,
    observeStatus = logSchedulerBackfillStatus,
  }: BackfillOptions): SchedulerTask =>
  async ({ db, job, logger, runId, scheduleContinuation, signal }) => {
    if (
      readParsedInputStateBackfillEnvironment()
        .CASE_LAW_PARSED_INPUT_STATE_BACKFILL_KILL_SWITCH
    ) {
      logger.info(
        "scheduler.case_law_parsed_input_state_backfill_disabled",
        {},
      );
      return;
    }
    if (job.payload?.["completed"] === true) {
      return;
    }
    signal.throwIfAborted();
    const leaseToken =
      job.lockedBy ??
      panic("Parsed input state backfill requires a scheduler lease");
    const runtime = createRuntime({
      db,
      name: SCHEDULER_BACKFILL_IDS.parsedInputState,
      tableName: "case_law_decisions",
      initialSize: pageRows,
      config: {
        ...SCHEDULER_BACKFILL_CONFIG,
        minSize: Math.min(100, pageRows),
        maxSize: pageRows,
      },
      clock,
      readVerdict,
      observeStatus,
      reporting: "changes",
      statementTimeoutPolicy: "fail",
    });
    const settled = await Result.tryPromise({
      try: async () => {
        try {
          return await runtime.step(async ({ tx, cursor, size }) => {
            signal.throwIfAborted();
            const page = await tx
              .select({ id: caseLawDecisions.id })
              .from(caseLawDecisions)
              .where(
                cursor === null
                  ? undefined
                  : gt(caseLawDecisions.id, sql`${cursor}::uuid`),
              )
              .orderBy(asc(caseLawDecisions.id))
              .limit(size);
            const last = page.at(-1);
            if (last === undefined) {
              // Use the scheduler's one-shot retirement mechanism. Persist it
              // with the final checkpoint so a crash cannot restart the walk.
              await tx
                .update(schedulerJobs)
                .set({
                  enabled: false,
                  payload: sql`coalesce(${schedulerJobs.payload}, '{}'::jsonb) || '{"completed":true}'::jsonb`,
                })
                .where(
                  and(
                    eq(schedulerJobs.id, job.id),
                    eq(schedulerJobs.lockedBy, leaseToken),
                  ),
                );
              return { cursor: null, done: true, value: 0 };
            }
            const updated = await deriveCaseLawParsedInputStateBatch({
              tx,
              ids: page.map(({ id }) => id),
              recordTransitionAuditEvent: async (count) => {
                await recordSystemAudit(
                  tx,
                  "system:case-law-parsed-input-state-backfill",
                  {
                    subject: runId,
                    counts: { updatedDecisions: count },
                  },
                );
              },
            });
            return { cursor: last.id, done: false, value: updated };
          });
        } finally {
          await runtime.close();
        }
      },
      catch: (cause: unknown) => cause,
    });
    if (settled.isErr()) {
      if (settled.error instanceof BackfillHeldError) {
        logger.info(
          "scheduler.case_law_parsed_input_state_backfill_held",
          sanitizeErrorAttributesForOutput({
            ...(settled.error.holdUntil === null
              ? {}
              : { holdUntil: settled.error.holdUntil }),
            ...(settled.error.heldSince === null
              ? {}
              : { heldSince: settled.error.heldSince }),
          }),
        );
        return;
      }
      return Result.err(
        new SchedulerTaskFailure({
          message: "Case-law parsed input state backfill failed",
          cause: settled.error,
        }),
      );
    }
    logger.info("scheduler.case_law_parsed_input_state_backfilled", {
      "parsedInputState.updated": settled.value.value,
      "parsedInputState.status": settled.value.done ? "complete" : "progress",
    });
    if (!settled.value.done && !signal.aborted) {
      scheduleContinuation(
        new Date(
          clock() + Math.max(CONTINUATION_DELAY_MS, settled.value.sleepMs),
        ),
      );
    }
  };
