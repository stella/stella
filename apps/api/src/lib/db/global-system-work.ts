import { panic } from "better-result";
import { and, eq, or, sql } from "drizzle-orm";

import { createSafeId } from "@/api/lib/branded-types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

import type { Transaction } from "../../db/root";
import { flowDefinitions, schedulerJobs } from "../../db/schema";
import type { SchedulerPayload } from "../../db/schema";
import {
  FLOW_RUN_TASK,
  flowScheduleJobId,
} from "../scheduler/flow-schedule-identity";

type GlobalSystemJob =
  | {
      type: "flow-schedule-orphan-page";
      originals: readonly { id: string; payload: SchedulerPayload }[];
    }
  | {
      type: "flow-schedule-orphan-claim";
      jobId: string;
      lockedBy: string;
      definitionId: string;
    };

/** Tenantless cleanup intents and their only callers. */
export const GLOBAL_SYSTEM_JOBS = {
  "flow-schedule-orphan-page": {
    owner: "apps/api/src/lib/flows/sync-flow-schedule-trigger.ts",
  },
  "flow-schedule-orphan-claim": {
    owner: "apps/api/src/lib/scheduler/tasks/flow-run.ts",
  },
} as const satisfies Record<GlobalSystemJob["type"], { owner: string }>;

/** The closed door accepts an exact cleanup intent, never an owner callback. */
export const runGlobalSystemWork = async (
  tx: Pick<Transaction, "select" | "delete" | "insert">,
  job: GlobalSystemJob,
): Promise<void> => {
  const context = (
    await tx
      .select({
        owner: sql<boolean>`current_user = session_user AND current_user NOT IN ('stella', 'stella_system')`,
      })
      .from(sql`(SELECT 1) AS global_context`)
      .limit(1)
  ).at(0);
  if (context?.owner !== true) {
    return panic("Global system work requires its owner context");
  }
  const absentSource = and(
    eq(schedulerJobs.task, FLOW_RUN_TASK),
    sql`jsonb_typeof(${schedulerJobs.payload}) = 'object'`,
    sql`${schedulerJobs.id} = ${`${FLOW_RUN_TASK}.`} || (${schedulerJobs.payload}->>'definitionId')`,
    sql`NOT EXISTS (SELECT 1 FROM ${flowDefinitions}
      WHERE ${flowDefinitions.id}::text = lower(${schedulerJobs.payload}->>'definitionId'))`,
  );
  switch (job.type) {
    case "flow-schedule-orphan-page": {
      if (job.originals.length === 0) {
        return;
      }
      const removed = await tx
        .delete(schedulerJobs)
        .where(
          and(
            absentSource,
            or(
              ...job.originals.map(({ id, payload }) =>
                and(
                  eq(schedulerJobs.id, id),
                  eq(schedulerJobs.payload, payload),
                ),
              ),
            ),
          ),
        )
        .returning({ id: schedulerJobs.id });
      await recordSystemAudit(tx, "system:flow-schedule-orphan-cleanup", {
        subject: createSafeId<"systemScriptRun">(),
        counts: { schedulerJobs: removed.length },
      });
      return;
    }
    case "flow-schedule-orphan-claim": {
      if (job.jobId !== flowScheduleJobId(job.definitionId)) {
        return panic("Global cleanup claim has a different source");
      }
      const removed = await tx
        .delete(schedulerJobs)
        .where(
          and(
            absentSource,
            eq(schedulerJobs.id, job.jobId),
            eq(schedulerJobs.lockedBy, job.lockedBy),
            sql`lower(${schedulerJobs.payload}->>'definitionId') = lower(${job.definitionId})`,
          ),
        )
        .returning({ id: schedulerJobs.id });
      await recordSystemAudit(tx, "system:flow-schedule-orphan-cleanup", {
        subject: createSafeId<"systemScriptRun">(),
        counts: { schedulerJobs: removed.length },
      });
      return;
    }
    default:
      job satisfies never;
      return panic("Unknown global system job");
  }
};
