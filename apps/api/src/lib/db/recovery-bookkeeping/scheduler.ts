import { panic } from "better-result";
import { and, eq, or, sql } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import type {
  flowDefinitions,
  SchedulerPayload,
  schedulerJobs,
} from "@/api/db/schema";

type JobValues = Required<
  Pick<
    typeof schedulerJobs.$inferInsert,
    | "id"
    | "description"
    | "enabled"
    | "nextRunAt"
    | "payload"
    | "schedule"
    | "task"
  >
>;

type SchedulerBookkeepingOperation = {
  table: typeof schedulerJobs;
} & (
  | {
      type: "upsert";
      db: Pick<ScopedTransaction, "insert">;
      values: JobValues;
      refreshNextRunAt: boolean;
      replacePayload: boolean;
    }
  | {
      type: "delete-source";
      db: Pick<ScopedTransaction, "delete">;
      jobId: string;
    }
  | {
      type: "delete-claimed-orphan";
      db: Pick<ScopedTransaction, "delete">;
      jobId: string;
      lockedBy: string;
    }
  | {
      type: "delete-orphans";
      db: Pick<ScopedTransaction, "delete">;
      definitions: typeof flowDefinitions;
      task: (typeof schedulerJobs.$inferSelect)["task"];
      originals: readonly { id: string; payload: SchedulerPayload }[];
    }
  | {
      type: "checkpoint-slot";
      db: Pick<ScopedTransaction, "update">;
      jobId: string;
      lockedBy: string;
      payload: SchedulerPayload;
    }
);

type SlotCheckpoint = Extract<
  SchedulerBookkeepingOperation,
  { type: "checkpoint-slot" }
>;

export function writeSchedulerBookkeeping(
  operation: SlotCheckpoint,
): Promise<{ id: string }[]>;
export function writeSchedulerBookkeeping(
  operation: Exclude<SchedulerBookkeepingOperation, SlotCheckpoint>,
): Promise<void>;
export async function writeSchedulerBookkeeping(
  operation: SchedulerBookkeepingOperation,
): Promise<void | { id: string }[]> {
  // audit: skip — derived scheduler configuration, exact-claim slot checkpoints and source-absent cleanup; scheduler_job_runs records attempts.
  const { table } = operation;
  switch (operation.type) {
    case "upsert": {
      const { description, enabled, nextRunAt, payload, schedule, task } =
        operation.values;
      await operation.db
        .insert(table)
        .values(operation.values)
        .onConflictDoUpdate({
          target: table.id,
          set: {
            description,
            enabled,
            ...(operation.refreshNextRunAt && { nextRunAt }),
            ...(operation.replacePayload && { payload }),
            schedule,
            task,
          },
        });
      return;
    }
    case "delete-source":
      await operation.db.delete(table).where(eq(table.id, operation.jobId));
      return;
    case "delete-claimed-orphan":
      await operation.db
        .delete(table)
        .where(
          and(
            eq(table.id, operation.jobId),
            eq(table.lockedBy, operation.lockedBy),
          ),
        );
      return;
    case "delete-orphans":
      if (operation.originals.length === 0) {
        return;
      }
      await operation.db.delete(table).where(
        and(
          eq(table.task, operation.task),
          sql`NOT EXISTS (
            SELECT 1 FROM ${operation.definitions}
            WHERE ${operation.definitions.id}::text = lower(${table.payload}->>'definitionId')
          )`,
          or(
            ...operation.originals.map(({ id, payload }) =>
              and(eq(table.id, id), eq(table.payload, payload)),
            ),
          ),
        ),
      );
      return;
    case "checkpoint-slot":
      return await operation.db
        .update(table)
        .set({ payload: operation.payload })
        .where(
          and(
            eq(table.id, operation.jobId),
            eq(table.lockedBy, operation.lockedBy),
          ),
        )
        .returning({ id: table.id });
    default:
      operation satisfies never;
      return panic("Unknown scheduler bookkeeping operation");
  }
}
