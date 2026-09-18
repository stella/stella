import { panic, Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { TIME_ENTRY_SOURCE, timeEntries } from "@/api/db/schema";
import type { TimeEntrySource } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { resolveRate } from "@/api/lib/billing-rates";
import {
  getTimeEntryDateValidationError,
  roundToBillingIncrement,
} from "@/api/lib/billing-time";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

type TimeEntryInsertInput = {
  workItemId?: SafeId<"entity"> | null | undefined;
  dateWorked: string;
  timezoneId: string;
  durationMinutes: number;
  narrative: string;
  billable?: boolean | undefined;
  taskCode?: string | null | undefined;
  activityCode?: string | null | undefined;
};

type PrepareTimeEntryInsertProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  body: TimeEntryInsertInput;
};

type PreparedTimeEntry = {
  workItemId: SafeId<"entity"> | null;
  dateWorked: string;
  timezoneId: string;
  durationMinutes: number;
  billedMinutes: number;
  rateAtEntry: number;
  currency: string;
  narrative: string;
  billable: boolean;
  taskCode: string | null;
  activityCode: string | null;
};

// Validation and rate resolution shared by every path that creates a time
// entry: the date window, the optional work item, and the effective rate.
// Runs outside the insert transaction so the transaction stays short.
export const prepareTimeEntryInsert = async function* ({
  safeDb,
  workspaceId,
  userId,
  body,
}: PrepareTimeEntryInsertProps) {
  const todayStr = yield* formatTodayInTimeZone({
    timezoneId: body.timezoneId,
  });
  const dateValidationError = getTimeEntryDateValidationError({
    dateWorked: body.dateWorked,
    today: todayStr,
  });
  if (dateValidationError) {
    return yield* Result.err(
      new HandlerError({
        status: 400,
        message: dateValidationError,
      }),
    );
  }

  const workItemId = body.workItemId ?? null;

  if (workItemId) {
    const workItem = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: workItemId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!workItem) {
      return yield* Result.err(
        new HandlerError({
          status: 400,
          message: "Work item not found in this matter",
        }),
      );
    }
  }

  const resolvedRate = yield* resolveRate({
    safeDb,
    workspaceId,
    userId,
    dateWorked: body.dateWorked,
  });
  const billable = body.billable ?? true;
  if (billable && !resolvedRate) {
    return yield* Result.err(
      new HandlerError({
        status: 400,
        message: "Billable time entries need an effective rate",
      }),
    );
  }

  const prepared: PreparedTimeEntry = {
    workItemId,
    dateWorked: body.dateWorked,
    timezoneId: body.timezoneId,
    durationMinutes: body.durationMinutes,
    billedMinutes: roundToBillingIncrement(body.durationMinutes),
    rateAtEntry: resolvedRate?.hourlyRate ?? 0,
    currency: resolvedRate?.currency ?? UNPRICED_TIME_ENTRY_CURRENCY,
    narrative: body.narrative,
    billable,
    taskCode: body.taskCode ?? null,
    activityCode: body.activityCode ?? null,
  };
  return prepared;
};

type TimeEntryCapacityCheck = Result<void, HandlerError<400>>;

/**
 * Serialises entry creation per matter and checks the per-matter cap. Runs
 * before any write in the caller's transaction, so a full matter is answered
 * with a `Result.err` and nothing to roll back.
 */
export const lockTimeEntryCapacity = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<TimeEntryCapacityCheck> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
  const count = await tx.$count(
    timeEntries,
    eq(timeEntries.workspaceId, workspaceId),
  );
  if (count >= LIMITS.timeEntriesPerWorkspace) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Time entries limit reached for this workspace",
      }),
    );
  }
  return Result.ok(undefined);
};

type InsertPreparedTimeEntryOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  source: TimeEntrySource;
  prepared: PreparedTimeEntry;
  recordAuditEvent: AuditRecorder;
};

/**
 * Inserts a prepared entry and writes its audit event in the caller's
 * transaction. Call `lockTimeEntryCapacity` first: this step has no failure
 * of its own, so the transaction never needs to abort after it.
 */
export const insertPreparedTimeEntry = async ({
  tx,
  organizationId,
  workspaceId,
  userId,
  source,
  prepared,
  recordAuditEvent,
}: InsertPreparedTimeEntryOptions): Promise<{ id: SafeId<"timeEntry"> }> => {
  const [entry] = await tx
    .insert(timeEntries)
    .values({
      organizationId,
      workspaceId,
      userId,
      workItemId: prepared.workItemId,
      dateWorked: prepared.dateWorked,
      timezoneId: prepared.timezoneId,
      durationMinutes: prepared.durationMinutes,
      billedMinutes: prepared.billedMinutes,
      rateAtEntry: cents(prepared.rateAtEntry),
      currency: prepared.currency,
      narrative: prepared.narrative,
      billable: prepared.billable,
      taskCode: prepared.taskCode,
      activityCode: prepared.activityCode,
      source,
    })
    .returning({ id: timeEntries.id });

  if (!entry) {
    return panic("time entry insert returned no row");
  }

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
    resourceId: entry.id,
    changes: {
      created: {
        old: null,
        new: {
          workItemId: prepared.workItemId,
          dateWorked: prepared.dateWorked,
          durationMinutes: prepared.durationMinutes,
          billedMinutes: prepared.billedMinutes,
          rateAtEntry: cents(prepared.rateAtEntry),
          currency: prepared.currency,
          billable: prepared.billable,
          source,
        },
      },
    },
  });

  return { id: entry.id };
};

type CreateTimeEntryHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: TimeEntryInsertInput;
};

// Shared time-entry creation logic reused by the HTTP handler and the
// `save_time_entry` MCP tool, so both run the same validation, advisory-lock
// limit check, and audit event.
export const createTimeEntryHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  body,
}: CreateTimeEntryHandlerProps) {
  const prepared = yield* prepareTimeEntryInsert({
    safeDb,
    workspaceId,
    userId,
    body,
  });

  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      const capacity = await lockTimeEntryCapacity(tx, workspaceId);
      if (capacity.isErr()) {
        return capacity;
      }
      return Result.ok(
        await insertPreparedTimeEntry({
          tx,
          organizationId,
          workspaceId,
          userId,
          source: TIME_ENTRY_SOURCE.MANUAL,
          prepared,
          recordAuditEvent,
        }),
      );
    }),
  );
  const created = yield* outcome;

  return Result.ok({ id: created.id });
};
