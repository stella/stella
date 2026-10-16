import { panic, Result } from "better-result";
import { and, eq, ne, sql } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { TIME_ENTRY_SOURCE, timeEntries } from "@/api/db/schema";
import type { TimeEntrySource } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import {
  getTimePolicyViolation,
  readTimePolicy,
  roundToBillingIncrement,
} from "@/api/lib/billing-time";
import type { TimePolicy } from "@/api/lib/billing-time";
import { resolveRate, type ResolvedRate } from "@/api/lib/billing/rates";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import { lockTimerOwner } from "@/api/lib/billing/time-timers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

type TimeEntryInsertInput = {
  workItemId?: SafeId<"entity"> | null | undefined;
  dateWorked: string;
  timezoneId: string;
  durationMinutes: number;
  narrative: string;
  narrativeLanguage?: string | null | undefined;
  billable?: boolean | undefined;
  noCharge?: boolean | undefined;
  invoiceNarrative?: string | null | undefined;
  taskCode?: string | null | undefined;
  activityCode?: string | null | undefined;
};

type PrepareTimeEntryInsertProps = {
  safeDb: SafeDb;
  policy: TimePolicy;
  canApprove: boolean;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  body: TimeEntryInsertInput;
  dateWindow?: "entry" | "timer_completion";
  resolvedRate?: ResolvedRate | null | undefined;
  billingSnapshot?: { hourlyRate: number; currency: string } | undefined;
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
  narrativeLanguage: string | null;
  billable: boolean;
  noCharge: boolean;
  invoiceNarrative: string | null;
  taskCode: string | null;
  activityCode: string | null;
};

type TimeEntryPolicyCheckOptions = {
  policy: TimePolicy;
  canApprove: boolean;
  body: Pick<TimeEntryInsertInput, "dateWorked" | "timezoneId" | "narrative">;
  dateWindow: "entry" | "timer_completion";
};
const checkInsertTimePolicy = function* ({
  policy,
  canApprove,
  body,
  dateWindow,
}: TimeEntryPolicyCheckOptions) {
  const today = yield* formatTodayInTimeZone({ timezoneId: body.timezoneId });
  const violation = getTimePolicyViolation({
    policy,
    dateWorked: body.dateWorked,
    today,
    // Completing a previously started timer preserves the original stop semantics.
    canApprove: canApprove || dateWindow === "timer_completion",
    narrative: body.narrative,
  });
  if (violation) {
    return yield* Result.err(violation);
  }
  return undefined;
};

// Validation and rate resolution shared by every path that creates a time
// entry: the date window, the optional work item, and the effective rate.
// May reuse a caller-owned transaction when a timer must be consumed atomically.
export const prepareTimeEntryInsert = async function* ({
  safeDb,
  policy,
  canApprove,
  workspaceId,
  userId,
  body,
  dateWindow = "entry",
  billingSnapshot,
  resolvedRate: preResolvedRate,
}: PrepareTimeEntryInsertProps) {
  yield* checkInsertTimePolicy({ policy, canApprove, body, dateWindow });

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

  const resolvedRate =
    preResolvedRate !== undefined
      ? preResolvedRate
      : (billingSnapshot ??
        (yield* resolveRate({
          safeDb,
          workspaceId,
          userId,
          dateWorked: body.dateWorked,
        })));
  const billable =
    body.billable ??
    (dateWindow === "timer_completion" ? resolvedRate !== null : true);
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
    billedMinutes: roundToBillingIncrement(
      body.durationMinutes,
      policy.timeMinimumUnitMinutes,
    ),
    rateAtEntry: resolvedRate?.hourlyRate ?? 0,
    currency: resolvedRate?.currency ?? UNPRICED_TIME_ENTRY_CURRENCY,
    narrative: body.narrative,
    narrativeLanguage: body.narrativeLanguage ?? null,
    billable,
    noCharge: body.noCharge ?? false,
    invoiceNarrative: body.invoiceNarrative ?? null,
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
type LockTimeEntryCapacityOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  replacedEntryId?: SafeId<"timeEntry"> | undefined;
  requestedEntries?: number;
};
export const lockTimeEntryCapacity = async ({
  tx,
  workspaceId,
  replacedEntryId,
  requestedEntries = 1,
}: LockTimeEntryCapacityOptions): Promise<TimeEntryCapacityCheck> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
  const count = await tx.$count(
    timeEntries,
    and(
      eq(timeEntries.workspaceId, workspaceId),
      replacedEntryId ? ne(timeEntries.id, replacedEntryId) : undefined,
    ),
  );
  if (count + requestedEntries > LIMITS.timeEntriesPerWorkspace) {
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
  const matter = await tx.query.workspaces.findFirst({
    where: {
      id: { eq: workspaceId },
      organizationId: { eq: organizationId },
    },
    columns: { leadUserId: true },
  });
  if (!matter) {
    return panic("Authorized matter disappeared before time entry creation");
  }
  const [entry] = await tx
    .insert(timeEntries)
    .values({
      organizationId,
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
      workspaceId,
      userId,
      approverUserId: matter.leadUserId,
      workItemId: prepared.workItemId,
      dateWorked: prepared.dateWorked,
      timezoneId: prepared.timezoneId,
      durationMinutes: prepared.durationMinutes,
      billedMinutes: prepared.billedMinutes,
      rateAtEntry: cents(prepared.rateAtEntry),
      currency: prepared.currency,
      narrative: prepared.narrative,
      narrativeLanguage: prepared.narrativeLanguage,
      billable: prepared.billable,
      noCharge: prepared.noCharge,
      invoiceNarrative: prepared.invoiceNarrative,
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
    workspaceId,
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

type InternalTimeEntryInput = Pick<
  TimeEntryInsertInput,
  | "dateWorked"
  | "timezoneId"
  | "durationMinutes"
  | "narrative"
  | "narrativeLanguage"
>;
type PrepareInternalTimeEntryOptions = {
  policy: TimePolicy;
  canApprove: boolean;
  body: InternalTimeEntryInput;
  dateWindow?: "entry" | "timer_completion";
};

export const prepareInternalTimeEntryInsert = function* ({
  policy,
  canApprove,
  body,
  dateWindow = "entry",
}: PrepareInternalTimeEntryOptions) {
  yield* checkInsertTimePolicy({ policy, canApprove, body, dateWindow });
  return {
    dateWorked: body.dateWorked,
    timezoneId: body.timezoneId,
    durationMinutes: body.durationMinutes,
    narrative: body.narrative,
    narrativeLanguage: body.narrativeLanguage ?? null,
    billedMinutes: 0,
  };
};

type InternalEntryOwner = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
export const lockInternalTimeEntryCapacity = async ({
  tx,
  organizationId,
  userId,
}: InternalEntryOwner) => {
  await lockTimerOwner(tx, { organizationId, userId });
  const count = await tx.$count(
    timeEntries,
    and(
      eq(timeEntries.organizationId, organizationId),
      eq(timeEntries.userId, userId),
      eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.INTERNAL),
    ),
  );
  if (count >= LIMITS.internalTimeEntriesPerUser) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "time_entry_limit",
        message: "Internal time entry limit reached",
        hint: "Export or remove older internal entries before creating more.",
      }),
    );
  }
  return Result.ok(undefined);
};

type InsertInternalTimeEntryOptions = InternalEntryOwner & {
  source: TimeEntrySource;
  prepared: InternalTimeEntryInput;
  recordAuditEvent: AuditRecorder;
};
/** Insert after the owner's capacity lock, within the same transaction. */
export const insertPreparedInternalTimeEntry = async ({
  tx,
  organizationId,
  userId,
  source,
  prepared,
  recordAuditEvent,
}: InsertInternalTimeEntryOptions) => {
  const [entry] = await tx
    .insert(timeEntries)
    .values({
      organizationId,
      userId,
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      workspaceId: null,
      workItemId: null,
      approverUserId: null,
      dateWorked: prepared.dateWorked,
      timezoneId: prepared.timezoneId,
      durationMinutes: prepared.durationMinutes,
      billedMinutes: 0,
      rateAtEntry: cents(0),
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
      narrative: prepared.narrative,
      narrativeLanguage: prepared.narrativeLanguage ?? null,
      billable: false,
      noCharge: false,
      taskCode: null,
      activityCode: null,
      invoiceId: null,
      invoiceNarrative: null,
      source,
    })
    .returning({ id: timeEntries.id });
  if (!entry) {
    return panic("Internal time entry insert returned no row");
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
    resourceId: entry.id,
    workspaceId: null,
    changes: {
      created: {
        old: null,
        new: {
          activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
          dateWorked: prepared.dateWorked,
          durationMinutes: prepared.durationMinutes,
          billedMinutes: 0,
          billable: false,
          source,
        },
      },
    },
  });
  return { id: entry.id };
};

type CreateTimeEntryHandlerProps = {
  source?: TimeEntrySource;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  recordAuditEvent: AuditRecorder;
  body: TimeEntryInsertInput;
};

// Shared time-entry creation logic reused by the HTTP handler and the
// `save_time_entry` MCP tool, so both run the same validation, advisory-lock
// limit check, and audit event.
export const createTimeEntryHandler = async function* ({
  source = TIME_ENTRY_SOURCE.MANUAL,
  safeDb,
  organizationId,
  workspaceId,
  userId,
  memberRole,
  recordAuditEvent,
  body,
}: CreateTimeEntryHandlerProps) {
  const policy = yield* Result.await(
    readTimePolicy({ safeDb, organizationId }),
  );
  const prepared = yield* prepareTimeEntryInsert({
    safeDb,
    policy,
    canApprove: canApproveTimeEntries(memberRole),
    workspaceId,
    userId,
    body,
  });

  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      const capacity = await lockTimeEntryCapacity({ tx, workspaceId });
      if (capacity.isErr()) {
        return capacity;
      }
      return Result.ok(
        await insertPreparedTimeEntry({
          tx,
          organizationId,
          workspaceId,
          userId,
          source,
          prepared,
          recordAuditEvent,
        }),
      );
    }),
  );
  const created = yield* outcome;

  return Result.ok({ id: created.id });
};
