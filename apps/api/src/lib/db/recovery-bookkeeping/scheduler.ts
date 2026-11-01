import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type { OrgScopedTransaction } from "@/api/db/org-scope";
import type { Transaction } from "@/api/db/root";
import type { ScopedTransaction } from "@/api/db/safe-db";
import type { schedulerJobs, SchedulerPayload } from "@/api/db/schema";
import { withSkipLockedBatch } from "@/api/lib/db/aggregate-lock";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import type { JsonObject } from "@/api/lib/json-value";
import {
  SCHEDULER_TASK_AUTHORITY,
  type SchedulerTaskWithOwnership,
} from "@/api/lib/scheduler/task-authority";
import type { RECOVERY_SCAN_IDENTITIES } from "@/api/lib/scheduler/tasks/recovery-scan-identity";
import type { SchedulerDb, SchedulerJob } from "@/api/lib/scheduler/types";

type PlatformSchedulerTask = SchedulerTaskWithOwnership<"platform">;

export type PlatformSchedulerState =
  | { type: "checkpoint"; payload: JsonObject | null }
  | { type: "retire" }
  | { type: "checkpoint-and-retire"; payload: JsonObject | null };

type JobValues = Required<
  Pick<
    typeof schedulerJobs.$inferInsert,
    "id" | "description" | "enabled" | "nextRunAt" | "schedule" | "task"
  >
> & { payload: JsonObject | null };

export type PlatformRunnerFinishState =
  | { type: "success"; startedAt: Date; finishedAt: Date; nextRunAt: Date }
  | {
      type: "failure";
      startedAt: Date;
      finishedAt: Date;
      nextRunAt: Date;
      error: string;
    }
  | { type: "skip" };

type SearchSemanticState =
  | {
      type: "restart-verification";
      cleanPasses: number;
      passStartedAt: string;
      quietSince: string;
    }
  | {
      type: "dirty-verification";
      cursor: string | null;
      passStartedAt: string | null;
      quietSince: string;
    }
  | {
      type: "checkpoint-verification";
      cursor: string;
      dirty: boolean;
      cleanPasses: number;
      passStartedAt: string | null;
      quietSince: string;
    }
  | { type: "checkpoint-repair"; cursor: string }
  | { type: "complete" };

export type SearchSemanticTimestampsState = SearchSemanticState;

export type SchedulerOperatorPauseRow = {
  enabled: boolean;
  id: string;
  pauseReason: string | null;
  pausedBy: string | null;
  pausedSince: Date | null;
  pausedUntil: Date | null;
};

export type SchedulerOperatorPauseState =
  | {
      type: "pause";
      actor: string;
      reason: string;
      durationMinutes: number;
    }
  | { type: "resume"; actor: string; reason: string };

type SchedulerBookkeepingOperation = {
  table: typeof schedulerJobs;
} & (
  | {
      type: "upsert";
      ownership: "platform";
      db: Pick<ScopedTransaction, "execute">;
      values: JobValues & { task: SchedulerTaskWithOwnership<"platform"> };
      /** Written on conflict; null keeps the row's scheduled run. */
      refreshedNextRunAt: Date | null;
      replacePayload: boolean;
    }
  | {
      type: "upsert";
      ownership: "organization";
      db: OrgScopedTransaction;
      values: JobValues & { task: SchedulerTaskWithOwnership<"organization"> };
      refreshedNextRunAt: Date | null;
      replacePayload: boolean;
    }
  | {
      type: "delete-source";
      db: OrgScopedTransaction;
      jobId: string;
    }
  | {
      type: "checkpoint-slot";
      db: OrgScopedTransaction;
      jobId: string;
      lockedBy: string;
      payload: JsonObject;
    }
  | {
      type: "platform-state";
      db: Pick<ScopedTransaction, "update">;
      task: PlatformSchedulerTask;
      jobId: string;
      lockedBy: string;
      state: PlatformSchedulerState;
    }
  | {
      type: "recovery-scan-checkpoint";
      db: Pick<ScopedTransaction, "update">;
      task: (typeof RECOVERY_SCAN_IDENTITIES)[keyof typeof RECOVERY_SCAN_IDENTITIES]["task"];
      jobId: string;
      lockedBy: string;
      scan: JsonObject;
    }
  | {
      type: "agent-client-storage-complete";
      db: Pick<ScopedTransaction, "update">;
      task: "agentClients.backfillStorage";
      jobId: string;
      expectedPayload: SchedulerPayload | null;
    }
  | {
      type: "platform-runner-claim";
      db: SchedulerDb;
      runnableTasks: readonly string[];
      excludeJobIds: readonly string[];
      eligibilityAt: Date | null;
      leaseToken: string;
      leaseMs: number;
    }
  | {
      type: "platform-runner-claim-locked";
      db: Pick<ScopedTransaction, "update">;
      jobId: string;
      due: SQL | undefined;
      leaseToken: string;
      leaseMs: number;
    }
  | {
      type: "platform-register-one-shot";
      db: Pick<ScopedTransaction, "execute">;
      values: JobValues & { task: PlatformSchedulerTask };
    }
  | {
      type: "platform-runner-renew";
      db: Pick<ScopedTransaction, "update">;
      jobId: string;
      leaseToken: string;
      leaseMs: number;
    }
  | {
      type: "platform-runner-finish";
      db: Pick<ScopedTransaction, "update">;
      jobId: string;
      leaseToken: string;
      state: PlatformRunnerFinishState;
    }
  | {
      type: "platform-bound-pauses";
      db: Pick<ScopedTransaction, "update">;
    }
  | {
      type: "platform-retire-unknown-tasks";
      db: Pick<ScopedTransaction, "update">;
    }
  | {
      type: "search-semantic-state";
      task: Extract<PlatformSchedulerTask, "search.repairSemanticTimestamps">;
      db: Pick<SchedulerDb, "execute">;
      jobId: string;
      lockedBy: string;
      state: SearchSemanticState;
    }
  | {
      type: "operator-pause";
      db: Pick<MaintenanceDb, "execute">;
      jobId: string;
      state: SchedulerOperatorPauseState;
    }
);

export const SCHEDULER_WRITE_INTENT_DISPOSITIONS = {
  upsert: "by-task",
  "delete-source": "organization",
  "checkpoint-slot": "organization",
  "platform-state": "platform",
  "agent-client-storage-complete": "platform",
  "recovery-scan-checkpoint": "platform",
  "platform-runner-claim": "platform",
  "platform-runner-claim-locked": "platform",
  "platform-register-one-shot": "platform",
  "platform-runner-renew": "platform",
  "platform-runner-finish": "platform",
  "platform-bound-pauses": "platform",
  "platform-retire-unknown-tasks": "platform",
  "search-semantic-state": "platform",
  "operator-pause": "platform",
} as const satisfies Record<
  SchedulerBookkeepingOperation["type"],
  "organization" | "platform" | "by-task"
>;

type SlotCheckpoint = Extract<
  SchedulerBookkeepingOperation,
  { type: "checkpoint-slot" }
>;

type UpsertOperation = Extract<
  SchedulerBookkeepingOperation,
  { type: "upsert" }
>;
type OneShotRegistrationOperation = Extract<
  SchedulerBookkeepingOperation,
  { type: "platform-register-one-shot" }
>;
type SearchSemanticOperation = Extract<
  SchedulerBookkeepingOperation,
  { type: "search-semantic-state" }
>;
type OperatorPauseOperation = Extract<
  SchedulerBookkeepingOperation,
  { type: "operator-pause" }
>;

type PlatformRunnerFinishValues = Partial<
  Pick<
    typeof schedulerJobs.$inferInsert,
    | "lastError"
    | "lastFailureAt"
    | "lastRunAt"
    | "lastSuccessAt"
    | "lockedAt"
    | "lockedBy"
    | "lockedUntil"
    | "nextRunAt"
  >
>;

const platformRunnerFinishValues = (
  state: PlatformRunnerFinishState,
): PlatformRunnerFinishValues => {
  switch (state.type) {
    case "success":
      return {
        lastError: null,
        lastRunAt: state.startedAt,
        lastSuccessAt: state.finishedAt,
        lockedAt: null,
        lockedBy: null,
        lockedUntil: null,
        nextRunAt: state.nextRunAt,
      };
    case "failure":
      return {
        lastError: state.error,
        lastFailureAt: state.finishedAt,
        lastRunAt: state.startedAt,
        lockedAt: null,
        lockedBy: null,
        lockedUntil: null,
        nextRunAt: state.nextRunAt,
      };
    case "skip":
      return {
        lockedAt: null,
        lockedBy: null,
        lockedUntil: null,
      };
    default:
      state satisfies never;
      return panic("Unknown scheduler runner finish state");
  }
};

type SchedulerRunnerClaimOperation = Extract<
  SchedulerBookkeepingOperation,
  { type: "platform-runner-claim" }
>;

const schedulerRunnerClaimOptions = (
  operation: SchedulerRunnerClaimOperation,
) => {
  const { table } = operation;
  const eligibilityTime =
    operation.eligibilityAt === null
      ? sql`now()`
      : sql`${operation.eligibilityAt}::timestamptz`;
  const due = and(
    inArray(table.task, [...operation.runnableTasks]),
    eq(table.enabled, true),
    lte(table.nextRunAt, sql`${eligibilityTime}::timestamptz`),
    or(
      isNull(table.pausedUntil),
      lte(table.pausedUntil, sql`${eligibilityTime}::timestamptz`),
    ),
    or(isNull(table.lockedUntil), lte(table.lockedUntil, sql`now()`)),
  );
  return {
    database: operation.db,
    limit: 1,
    select: (tx: Transaction) =>
      tx
        .select()
        .from(table)
        .where(
          and(
            due,
            operation.excludeJobIds.length === 0
              ? undefined
              : notInArray(table.id, [...operation.excludeJobIds]),
          ),
        )
        .orderBy(asc(table.nextRunAt), asc(table.id))
        .limit(1)
        .$dynamic(),
    run: async (tx: Transaction, candidates: SchedulerJob[]) => {
      const candidate = candidates.at(0);
      if (candidate === undefined) {
        return null;
      }
      return await writeSchedulerBookkeeping({
        type: "platform-runner-claim-locked",
        table,
        db: tx,
        jobId: candidate.id,
        due,
        leaseToken: operation.leaseToken,
        leaseMs: operation.leaseMs,
      });
    },
  };
};

const renderSchedulerUpsert = (operation: UpsertOperation): SQL => {
  const { description, enabled, payload, schedule, task } = operation.values;
  const payloadValue =
    payload === null ? sql`NULL` : sql`${JSON.stringify(payload)}::text::jsonb`;
  const nextRunAtUpdate =
    operation.refreshedNextRunAt === null
      ? sql``
      : sql`, next_run_at = ${operation.refreshedNextRunAt.toISOString()}::timestamptz`;
  const payloadUpdate = operation.replacePayload
    ? sql`, payload = ${payloadValue}`
    : sql``;
  // Explicit columns preserve the role's column-level INSERT boundary.
  return sql`
    INSERT INTO ${operation.table} (id, task, description, schedule, payload, enabled, next_run_at, updated_at)
    VALUES (${operation.values.id}, ${task}, ${description}, ${JSON.stringify(schedule)}::text::jsonb,
      ${payloadValue}, ${enabled}, ${operation.values.nextRunAt.toISOString()}::timestamptz, now())
    ON CONFLICT (id) DO UPDATE SET
      task = ${task}, description = ${description},
      schedule = ${JSON.stringify(schedule)}::text::jsonb, enabled = ${enabled}, updated_at = now()
      ${nextRunAtUpdate}${payloadUpdate}
  `;
};

const renderOneShotRegistration = (
  operation: OneShotRegistrationOperation,
): SQL => {
  const { description, enabled, nextRunAt, payload, schedule, task } =
    operation.values;
  const payloadValue =
    payload === null ? sql`NULL` : sql`${JSON.stringify(payload)}::text::jsonb`;
  return sql`
    INSERT INTO ${operation.table} (id, task, description, schedule, payload, enabled, next_run_at, updated_at)
    VALUES (${operation.values.id}, ${task}, ${description}, ${JSON.stringify(schedule)}::text::jsonb,
      ${payloadValue}, ${enabled}, ${nextRunAt.toISOString()}::timestamptz, now())
    ON CONFLICT (id) DO NOTHING
  `;
};

const renderSearchSemanticState = (operation: SearchSemanticOperation): SQL => {
  const { jobId, lockedBy, state, task } = operation;
  const where = sql`WHERE id = ${jobId}
    AND task = ${task}
    AND locked_by = ${lockedBy}`;
  switch (state.type) {
    case "restart-verification":
      return sql`
        UPDATE scheduler_jobs
        SET payload = jsonb_build_object(
          'pass', 'verify'::text,
          'dirty', false,
          'cleanPasses', ${state.cleanPasses}::int,
          'passStartedAt', ${state.passStartedAt}::text,
          'quietSince', ${state.quietSince}::text
        )
        ${where}
      `;
    case "dirty-verification":
      return sql`
        UPDATE scheduler_jobs
        SET payload = jsonb_build_object(
          'cursor', ${state.cursor}::text,
          'pass', 'verify'::text,
          'dirty', true,
          'cleanPasses', 0,
          'passStartedAt', ${state.passStartedAt}::text,
          'quietSince', ${state.quietSince}::text
        )
        ${where}
      `;
    case "checkpoint-verification":
      return sql`
        UPDATE scheduler_jobs
        SET payload = jsonb_build_object(
          'cursor', ${state.cursor}::text,
          'pass', 'verify'::text,
          'dirty', ${state.dirty}::boolean,
          'cleanPasses', ${state.cleanPasses}::int,
          'passStartedAt', ${state.passStartedAt}::text,
          'quietSince', ${state.quietSince}::text
        )
        ${where}
      `;
    case "checkpoint-repair":
      return sql`
        UPDATE scheduler_jobs
        SET payload = jsonb_build_object(
          'cursor', ${state.cursor}::text,
          'pass', 'repair'::text
        )
        ${where}
      `;
    case "complete":
      return sql`
        UPDATE scheduler_jobs
        SET enabled = false
        ${where}
      `;
    default:
      state satisfies never;
      return panic("Unknown semantic timestamp scheduler state");
  }
};

const renderOperatorPause = (operation: OperatorPauseOperation): SQL => {
  const { actor, reason } = operation.state;
  switch (operation.state.type) {
    case "pause":
      return sql`
        UPDATE scheduler_jobs
        SET paused_by = ${actor},
            pause_reason = ${reason},
            paused_until = now() + ${operation.state.durationMinutes} * interval '1 minute',
            updated_at = now()
        WHERE id = ${operation.jobId}
        RETURNING id, enabled, paused_by AS "pausedBy", pause_reason AS "pauseReason",
          paused_since AS "pausedSince", paused_until AS "pausedUntil"
      `;
    case "resume":
      return sql`
        UPDATE scheduler_jobs
        SET paused_by = ${actor},
            pause_reason = ${reason},
            paused_until = NULL,
            updated_at = now()
        WHERE id = ${operation.jobId}
        RETURNING id, enabled, paused_by AS "pausedBy", pause_reason AS "pauseReason",
          paused_since AS "pausedSince", paused_until AS "pausedUntil"
      `;
    default:
      operation.state satisfies never;
      return panic("Unknown scheduler operator pause state");
  }
};

export function writeSchedulerBookkeeping(
  operation: Extract<
    SchedulerBookkeepingOperation,
    {
      type:
        | "recovery-scan-checkpoint"
        | "checkpoint-slot"
        | "platform-runner-renew";
    }
  >,
): Promise<{ id: string }[]>;
export function writeSchedulerBookkeeping(
  operation: Extract<
    SchedulerBookkeepingOperation,
    { type: "platform-runner-claim" | "platform-runner-claim-locked" }
  >,
): Promise<SchedulerJob | null>;
export function writeSchedulerBookkeeping(
  operation: Extract<
    SchedulerBookkeepingOperation,
    { type: "platform-bound-pauses" }
  >,
): Promise<{ id: string; pausedUntil: Date | null }[]>;
export function writeSchedulerBookkeeping(
  operation: Extract<
    SchedulerBookkeepingOperation,
    { type: "platform-retire-unknown-tasks" }
  >,
): Promise<{ id: string; task: string }[]>;
export function writeSchedulerBookkeeping(
  operation: Extract<SchedulerBookkeepingOperation, { type: "operator-pause" }>,
): Promise<SchedulerOperatorPauseRow[]>;
export function writeSchedulerBookkeeping(
  operation: Exclude<
    SchedulerBookkeepingOperation,
    | SlotCheckpoint
    | Extract<
        SchedulerBookkeepingOperation,
        {
          type:
            | "recovery-scan-checkpoint"
            | "platform-runner-claim"
            | "platform-runner-claim-locked"
            | "platform-runner-renew"
            | "platform-bound-pauses"
            | "platform-retire-unknown-tasks"
            | "operator-pause";
        }
      >
  >,
): Promise<void>;
export async function writeSchedulerBookkeeping(
  operation: SchedulerBookkeepingOperation,
): Promise<
  | void
  | { id: string }[]
  | SchedulerJob
  | null
  | { id: string; pausedUntil: Date | null }[]
  | { id: string; task: string }[]
  | SchedulerOperatorPauseRow[]
> {
  // audit: skip — derived scheduler configuration, exact-claim slot checkpoints and source-absent cleanup; scheduler_job_runs records attempts. Pure recovery bookkeeping; no user/customer data or auth/permission change.
  const { table } = operation;
  switch (operation.type) {
    case "upsert":
      await (
        operation.ownership === "organization" ? operation.db.tx : operation.db
      ).execute(renderSchedulerUpsert(operation));
      return;
    case "delete-source":
      await operation.db.tx.delete(table).where(eq(table.id, operation.jobId));
      return;
    case "checkpoint-slot":
      return await operation.db.tx
        .update(table)
        .set({ payload: operation.payload })
        .where(
          and(
            eq(table.id, operation.jobId),
            eq(table.lockedBy, operation.lockedBy),
          ),
        )
        .returning({ id: table.id });
    case "platform-state": {
      const where = and(
        eq(table.id, operation.jobId),
        eq(table.task, operation.task),
        eq(table.lockedBy, operation.lockedBy),
      );
      switch (operation.state.type) {
        case "checkpoint":
          await operation.db
            .update(table)
            .set({ payload: operation.state.payload })
            .where(where);
          return;
        case "retire":
          await operation.db.update(table).set({ enabled: false }).where(where);
          return;
        case "checkpoint-and-retire":
          await operation.db
            .update(table)
            .set({ enabled: false, payload: operation.state.payload })
            .where(where);
          return;
        default:
          operation.state satisfies never;
          return panic("Unknown platform scheduler job state");
      }
    }
    case "recovery-scan-checkpoint":
      return await operation.db
        .update(table)
        .set({
          payload: sql`jsonb_set(coalesce(${table.payload}, '{}'::jsonb), '{recoveryScan}', ${JSON.stringify(operation.scan)}::text::jsonb, true)`,
        })
        .where(
          and(
            eq(table.id, operation.jobId),
            eq(table.task, operation.task),
            eq(table.lockedBy, operation.lockedBy),
          ),
        )
        .returning({ id: table.id });
    case "agent-client-storage-complete":
      await operation.db
        .update(table)
        .set({
          enabled: false,
          payload: sql`coalesce(${table.payload}, '{}'::jsonb) || '{"completed":true}'::jsonb`,
        })
        .where(
          and(
            eq(table.id, operation.jobId),
            eq(table.task, operation.task),
            operation.expectedPayload === null
              ? isNull(table.payload)
              : eq(table.payload, operation.expectedPayload),
          ),
        );
      return;
    case "platform-runner-claim":
      return await withSkipLockedBatch(schedulerRunnerClaimOptions(operation));
    case "platform-runner-claim-locked": {
      const claimed = (
        await operation.db
          .update(table)
          .set({
            pausedUntil: null,
            lockedAt: sql`now()`,
            lockedBy: operation.leaseToken,
            lockedUntil: sql`now() + ${operation.leaseMs}::integer * interval '1 millisecond'`,
          })
          .where(and(eq(table.id, operation.jobId), operation.due))
          .returning()
      ).at(0);
      return (
        claimed ?? panic("Locked scheduler job disappeared before lease update")
      );
    }
    case "platform-register-one-shot":
      await operation.db.execute(renderOneShotRegistration(operation));
      return;
    case "platform-runner-renew":
      return await operation.db
        .update(table)
        .set({
          lockedUntil: sql`now() + ${operation.leaseMs}::integer * interval '1 millisecond'`,
        })
        .where(
          and(
            eq(table.id, operation.jobId),
            eq(table.lockedBy, operation.leaseToken),
            eq(table.enabled, true),
            or(isNull(table.pausedUntil), lte(table.pausedUntil, sql`now()`)),
          ),
        )
        .returning({ id: table.id });
    case "platform-runner-finish": {
      const where = and(
        eq(table.id, operation.jobId),
        eq(table.lockedBy, operation.leaseToken),
      );
      const values = platformRunnerFinishValues(operation.state);
      await operation.db
        .update(table)
        .set({
          lastError: values.lastError,
          lastFailureAt: values.lastFailureAt,
          lastRunAt: values.lastRunAt,
          lastSuccessAt: values.lastSuccessAt,
          lockedAt: values.lockedAt,
          lockedBy: values.lockedBy,
          lockedUntil: values.lockedUntil,
          nextRunAt: values.nextRunAt,
        })
        .where(where);
      return;
    }
    case "platform-bound-pauses": {
      const negativeInfinity = sql`'-infinity'::timestamptz`;
      return await operation.db
        .update(table)
        .set({
          pausedUntil: sql`CASE WHEN ${table.pausedUntil} = ${negativeInfinity}
            THEN NULL ELSE now() + interval '72 hours' END`,
        })
        .where(
          or(
            gt(table.pausedUntil, sql`now() + interval '72 hours'`),
            eq(table.pausedUntil, negativeInfinity),
          ),
        )
        .returning({ id: table.id, pausedUntil: table.pausedUntil });
    }
    case "platform-retire-unknown-tasks":
      return await operation.db
        .update(table)
        .set({ enabled: false })
        .where(
          and(
            eq(table.enabled, true),
            notInArray(table.task, Object.keys(SCHEDULER_TASK_AUTHORITY)),
          ),
        )
        .returning({ id: table.id, task: table.task });
    case "search-semantic-state":
      await operation.db.execute(renderSearchSemanticState(operation));
      return;
    case "operator-pause":
      return await operation.db.execute<SchedulerOperatorPauseRow>(
        renderOperatorPause(operation),
      );
    default:
      operation satisfies never;
      return panic("Unknown scheduler bookkeeping operation");
  }
}
