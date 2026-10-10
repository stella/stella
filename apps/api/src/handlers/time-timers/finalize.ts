import { Result } from "better-result";
import type { InferOk } from "better-result";
import { and, eq } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import type { TimeEntryActivityGroup } from "@stll/api-contract";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { withResultSavepoint } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeTimerConfirmations,
  timeTimers,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { lockTimePolicy } from "@/api/lib/billing-time";
import type { TimePolicy } from "@/api/lib/billing-time";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import {
  insertPreparedInternalTimeEntry,
  insertPreparedTimeEntry,
  lockInternalTimeEntryCapacity,
  prepareInternalTimeEntryInsert,
  lockTimeEntryCapacity,
  prepareTimeEntryInsert,
} from "@/api/lib/billing/time-entry-insert";
import type { TimerOwner } from "@/api/lib/billing/time-timers";
import {
  deleteLegacyTimerDraft,
  lockTimerOwner,
  ownedTimers,
  readOwnedTimer,
  timerNotFound,
  timerSeconds,
} from "@/api/lib/billing/time-timers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { hasCurrentTimerMatterAccess } from "@/api/lib/time-entry-timer-access";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const CONFIRMED_ENTRY_COLUMNS = {
  id: timeEntries.id,
  activityGroup: timeEntries.activityGroup,
  durationMinutes: timeEntries.durationMinutes,
  billedMinutes: timeEntries.billedMinutes,
};
type TimeEntryRow = typeof timeEntries.$inferSelect;
// Exact legacy values travel together; every persisted field is either here
// or explicitly classified as contextual, recomputed, or reset below.
// The no-charge disposition and invoice wording were written for the draft's
// own matter; completing it in another matter starts them over, as it does the
// rate snapshot.
const preservedLegacyBilling = (legacy: TimeEntryRow, sameMatter: boolean) => ({
  dateWorked: legacy.dateWorked,
  timezoneId: legacy.timezoneId,
  narrativeLanguage: legacy.narrativeLanguage,
  noCharge: sameMatter ? legacy.noCharge : false,
  invoiceNarrative: sameMatter ? legacy.invoiceNarrative : null,
  taskCode: legacy.taskCode,
  activityCode: legacy.activityCode,
});
const CONTEXTUAL_OR_RESET_LEGACY_FIELDS = [
  // Identity, matter context and owner are validated for the replacement.
  "id",
  "organizationId",
  "workspaceId",
  "userId",
  "activityGroup",
  "workItemId",
  // Rate and currency retain their snapshot only in the same matter; the owner
  // can override billability, and completion supplies the timer narrative.
  "rateAtEntry",
  "currency",
  "billable",
  "narrative",
  // Elapsed time, lifecycle and approval provenance belong to the new entry.
  "durationMinutes",
  "billedMinutes",
  "status",
  "source",
  "invoiceId",
  "invoiceAttachment",
  "splitGroupId",
  "timerStartedAt",
  "timerStoppedAt",
  "createdAt",
  "updatedAt",
  "approverUserId",
  "approvedByUserId",
  "approvedAt",
  "returnedByUserId",
  "returnedAt",
  "returnComment",
] as const satisfies readonly (keyof TimeEntryRow)[];
true satisfies UnprojectedColumns<
  TimeEntryRow,
  ReturnType<typeof preservedLegacyBilling>,
  (typeof CONTEXTUAL_OR_RESET_LEGACY_FIELDS)[number]
> extends never
  ? true
  : never;
true satisfies UnbackedProjectionKeys<
  TimeEntryRow,
  ReturnType<typeof preservedLegacyBilling>,
  (typeof CONTEXTUAL_OR_RESET_LEGACY_FIELDS)[number]
> extends never
  ? true
  : never;

const UNPROJECTED_CONFIRMED_ENTRY_COLUMNS = [
  // Scope and attribution remain on the owner's draft, not this completion receipt.
  "organizationId",
  "workspaceId",
  "userId",
  "workItemId",
  // The receipt reports identity and elapsed/billed minutes only; the draft owns
  // dates, billing details, narrative, classification and lifecycle metadata.
  "dateWorked",
  "timezoneId",
  "rateAtEntry",
  "currency",
  "narrative",
  "narrativeLanguage",
  "invoiceNarrative",
  "billable",
  "noCharge",
  "status",
  "source",
  "taskCode",
  "activityCode",
  "invoiceId",
  "invoiceAttachment",
  "splitGroupId",
  "timerStartedAt",
  "timerStoppedAt",
  "createdAt",
  "updatedAt",
  // The approval queue owns approval and return metadata.
  "approverUserId",
  "approvedByUserId",
  "approvedAt",
  "returnedByUserId",
  "returnedAt",
  "returnComment",
] as const satisfies readonly (keyof TimeEntryRow)[];
type MissingConfirmedEntryColumn = UnprojectedColumns<
  TimeEntryRow,
  typeof CONFIRMED_ENTRY_COLUMNS,
  (typeof UNPROJECTED_CONFIRMED_ENTRY_COLUMNS)[number]
>;
type UnexpectedConfirmedEntryColumn = UnbackedProjectionKeys<
  TimeEntryRow,
  typeof CONFIRMED_ENTRY_COLUMNS,
  (typeof UNPROJECTED_CONFIRMED_ENTRY_COLUMNS)[number]
>;
true satisfies MissingConfirmedEntryColumn extends never ? true : never;
true satisfies UnexpectedConfirmedEntryColumn extends never ? true : never;

// Reuse the current transaction for policy, context and rate reads; no nested
// transaction may observe a different timer or policy snapshot.
const transactionHandle =
  (tx: Transaction): SafeDb =>
  async (run) =>
    await Result.tryPromise(async () => await run(tx));

type ReadConfirmationOptions = {
  tx: Transaction;
  owner: TimerOwner;
  id: typeof timeTimers.$inferSelect.id;
};
const readConfirmation = async ({ tx, owner, id }: ReadConfirmationOptions) => {
  const [receipt] = await tx
    .select()
    .from(timeTimerConfirmations)
    .where(
      and(
        eq(timeTimerConfirmations.timerId, id),
        eq(timeTimerConfirmations.organizationId, owner.organizationId),
        eq(timeTimerConfirmations.userId, owner.userId),
      ),
    )
    .limit(1);
  if (receipt) {
    if (!receipt.timeEntryId) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "The confirmed entry was deleted",
          hint: "Create a new time entry if more work needs recording.",
        }),
      );
    }
    const [entry] = await tx
      .select(CONFIRMED_ENTRY_COLUMNS)
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.id, receipt.timeEntryId),
          eq(timeEntries.organizationId, owner.organizationId),
          eq(timeEntries.userId, owner.userId),
        ),
      )
      .limit(1);
    if (!entry) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Confirmed entry is no longer accessible",
        }),
      );
    }
    return Result.ok(entry);
  }
  return null;
};

type TimerCompletion =
  | {
      type: "owner";
      timezoneId: string;
      billable?: boolean | undefined;
      activityGroup?: TimeEntryActivityGroup | undefined;
    }
  | {
      type: "admin";
      actorId: TimerOwner["userId"];
      narrative?: string | undefined;
    };

type FinalizeTimerOptions = {
  tx: Transaction;
  owner: TimerOwner;
  id: typeof timeTimers.$inferSelect.id;
  memberRole: AuthorizedMemberRole;
  recordAuditEvent: AuditRecorder;
  completion: TimerCompletion;
};

type PrepareTimerOptions = {
  tx: Transaction;
  owner: TimerOwner;
  timer: typeof timeTimers.$inferSelect;
  legacy: typeof timeEntries.$inferSelect | undefined;
  memberRole: AuthorizedMemberRole;
  narrative: string;
  workspaceId: typeof timeTimers.$inferSelect.workspaceId;
  policy: TimePolicy;
  now: Date;
  completion: TimerCompletion;
};
type TimerCompletionTimezoneOptions = Pick<
  PrepareTimerOptions,
  "tx" | "owner" | "legacy" | "completion"
>;
const timerCompletionTimezone = async ({
  tx,
  owner,
  legacy,
  completion,
}: TimerCompletionTimezoneOptions) => {
  if (legacy) {
    return Result.ok(legacy.timezoneId);
  }
  if (completion.type === "owner") {
    return Result.ok(completion.timezoneId);
  }
  const [timerOwner] = await tx
    .select({ timezoneId: user.timezoneId })
    .from(user)
    .innerJoin(
      member,
      and(
        eq(member.userId, user.id),
        eq(member.organizationId, owner.organizationId),
      ),
    )
    .where(eq(user.id, owner.userId))
    .limit(1);
  if (!timerOwner) {
    return Result.err(
      new HandlerError({
        status: 404,
        code: "timer_owner_unavailable",
        message: "Timer owner is not accessible",
      }),
    );
  }
  return Result.ok(timerOwner.timezoneId);
};
const prepareTimer = async ({
  tx,
  owner,
  timer,
  legacy,
  memberRole,
  narrative,
  workspaceId,
  policy,
  now,
  completion,
}: PrepareTimerOptions) => {
  const timezoneResult = await timerCompletionTimezone({
    tx,
    owner,
    legacy,
    completion,
  });
  if (timezoneResult.isErr()) {
    return Result.err(timezoneResult.error);
  }
  const timezoneId = timezoneResult.value;
  const dateResult = formatTodayInTimeZone({
    timezoneId,
    now: timer.startedAt,
  });
  if (dateResult.isErr()) {
    return Result.err(dateResult.error);
  }
  const durationMinutes = Math.max(
    1,
    Math.round(timerSeconds(timer, now) / 60),
  );
  const preparedResult = await Result.gen(async function* () {
    const handle = transactionHandle(tx);
    if (workspaceId === null) {
      const prepared = yield* prepareInternalTimeEntryInsert({
        policy,
        canApprove: canApproveTimeEntries(memberRole),
        dateWindow: "timer_completion",
        body: {
          dateWorked: legacy?.dateWorked ?? dateResult.value,
          timezoneId,
          durationMinutes,
          narrative,
          narrativeLanguage: legacy?.narrativeLanguage,
        },
      });
      return Result.ok({
        activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
        prepared,
        durationMinutes,
      } as const);
    }
    const prepared = yield* prepareTimeEntryInsert({
      safeDb: handle,
      policy,
      canApprove: canApproveTimeEntries(memberRole),
      workspaceId,
      userId: owner.userId,
      dateWindow: "timer_completion",
      billingSnapshot:
        legacy?.workspaceId === workspaceId
          ? { hourlyRate: legacy.rateAtEntry, currency: legacy.currency }
          : undefined,
      body: {
        dateWorked: dateResult.value,
        timezoneId,
        ...(legacy
          ? preservedLegacyBilling(legacy, legacy.workspaceId === workspaceId)
          : {}),
        durationMinutes,
        narrative,
        billable:
          completion.type === "owner"
            ? (completion.billable ?? legacy?.billable)
            : legacy?.billable,
        workItemId:
          legacy?.workspaceId === workspaceId ? legacy.workItemId : null,
      },
    });
    return Result.ok({
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
      prepared,
      durationMinutes,
    } as const);
  });
  if (preparedResult.isErr()) {
    return Result.err(preparedResult.error);
  }
  return preparedResult;
};

type InsertTimerEntryOptions = {
  tx: Transaction;
  owner: TimerOwner;
  workspaceId: typeof timeTimers.$inferSelect.workspaceId;
  legacy: typeof timeEntries.$inferSelect | undefined;
  preparedEntry: InferOk<Awaited<ReturnType<typeof prepareTimer>>>;
  recordAuditEvent: AuditRecorder;
};
const insertTimerEntry = async ({
  tx,
  owner,
  workspaceId,
  legacy,
  preparedEntry,
  recordAuditEvent,
}: InsertTimerEntryOptions) => {
  if (preparedEntry.activityGroup === TIME_ENTRY_ACTIVITY_GROUP.INTERNAL) {
    const capacity = await lockInternalTimeEntryCapacity({ tx, ...owner });
    if (capacity.isErr()) {
      return capacity;
    }
    return Result.ok(
      await insertPreparedInternalTimeEntry({
        tx,
        ...owner,
        prepared: preparedEntry.prepared,
        source: TIME_ENTRY_SOURCE.TIMER,
        recordAuditEvent,
      }),
    );
  }
  if (!workspaceId) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Client timer requires a matter",
      }),
    );
  }
  const capacity = await lockTimeEntryCapacity({
    tx,
    workspaceId,
    replacedEntryId:
      legacy?.workspaceId === workspaceId ? legacy.id : undefined,
  });
  if (capacity.isErr()) {
    return capacity;
  }
  return Result.ok(
    await insertPreparedTimeEntry({
      tx,
      ...owner,
      workspaceId,
      source: TIME_ENTRY_SOURCE.TIMER,
      prepared: preparedEntry.prepared,
      recordAuditEvent,
    }),
  );
};

type FinishTimerConfirmationOptions = Pick<
  FinalizeTimerOptions,
  "tx" | "owner" | "recordAuditEvent" | "completion"
> & {
  timer: typeof timeTimers.$inferSelect;
  legacy: typeof timeEntries.$inferSelect | undefined;
  workspaceId: typeof timeTimers.$inferSelect.workspaceId;
  entryId: typeof timeEntries.$inferSelect.id;
  preparedEntry: InferOk<Awaited<ReturnType<typeof prepareTimer>>>;
  narrativeFromAdmin: boolean;
};
const finishTimerConfirmation = async ({
  tx,
  owner,
  recordAuditEvent,
  completion,
  timer,
  legacy,
  workspaceId,
  entryId,
  preparedEntry,
  narrativeFromAdmin,
}: FinishTimerConfirmationOptions) => {
  await tx
    .insert(timeTimerConfirmations)
    .values({ ...owner, timerId: timer.id, timeEntryId: entryId });
  const deleted = await tx
    .delete(timeTimers)
    .where(and(ownedTimers(owner), eq(timeTimers.id, timer.id)))
    .returning({ id: timeTimers.id });
  if (deleted.length !== 1) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "timer_completion_changed",
        message: "Timer could not be ended",
        hint: "Reload running timers and retry.",
      }),
    );
  }
  if (legacy) {
    await deleteLegacyTimerDraft({
      tx,
      owner,
      entry: legacy,
      timerId: timer.id,
      recordAuditEvent,
    });
  }

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.DELETE,
    resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
    resourceId: timer.id,
    workspaceId,
    changes: {
      confirmedEntryId: { old: null, new: entryId },
      ...(completion.type === "admin"
        ? {
            endedByAdmin: { old: null, new: completion.actorId },
            ownerId: { old: owner.userId, new: owner.userId },
            narrativeFromAdmin: { old: null, new: narrativeFromAdmin },
          }
        : {}),
    },
  });
  return Result.ok({
    id: entryId,
    activityGroup: preparedEntry.activityGroup,
    durationMinutes: preparedEntry.durationMinutes,
    billedMinutes: preparedEntry.prepared.billedMinutes,
  });
};

const finalizeTimerInSavepoint = async ({
  tx,
  owner,
  id,
  memberRole,
  recordAuditEvent,
  completion,
}: FinalizeTimerOptions) => {
  const policy = await lockTimePolicy(tx, owner.organizationId);
  await lockTimerOwner(tx, owner);
  const replay = await readConfirmation({ tx, owner, id });
  if (replay) {
    return replay;
  }
  const timer = await readOwnedTimer({
    tx,
    owner,
    id,
    lock: completion.type === "admin" ? "advisory" : "update",
  });
  if (!timer) {
    return Result.err(timerNotFound(completion.type));
  }
  const workspaceId = timer.workspaceId;
  const internalRequested =
    completion.type === "owner" &&
    completion.activityGroup === TIME_ENTRY_ACTIVITY_GROUP.INTERNAL;
  if (
    internalRequested &&
    (workspaceId !== null || completion.billable === true)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "invalid_internal_timer",
        message: "Internal timers must have no matter and cannot be billable",
        hint: "Remove the timer's matter and omit billable or set it to false.",
      }),
    );
  }
  if (!workspaceId && !internalRequested) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "timer_matter_required",
        message: "A matter is required to confirm a timer",
        hint: {
          admin:
            "Ask the timer owner to assign an accessible matter, then retry time-timers.admin.stop.",
          owner: "Update the timer with a matterId, then confirm it again.",
        }[completion.type],
      }),
    );
  }
  if (
    workspaceId &&
    !(await hasCurrentTimerMatterAccess({ tx, ...owner, workspaceId }))
  ) {
    return Result.err(
      new HandlerError({
        status: 404,
        code: "timer_matter_inaccessible",
        message: "Matter not found or not accessible",
        hint: {
          admin:
            "Restore the timer owner's matter access or ask them to reassign it, then retry time-timers.admin.stop.",
          owner: "Update the timer to a matter you can access.",
        }[completion.type],
      }),
    );
  }
  const legacy = timer.legacyTimeEntryId
    ? (
        await tx
          .select()
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.id, timer.legacyTimeEntryId),
              eq(timeEntries.organizationId, owner.organizationId),
              eq(timeEntries.userId, owner.userId),
            ),
          )
          .limit(1)
          .for("update")
      ).at(0)
    : undefined;
  if (timer.legacyTimeEntryId && !legacy) {
    return Result.err(
      new HandlerError({
        status: 404,
        code: "timer_original_entry_inaccessible",
        message: "Original timer entry is not accessible",
        hint: {
          admin:
            "Restore the timer owner's access to the original matter, then retry time-timers.admin.stop.",
          owner:
            "Restore access to the original matter before confirming this migrated timer.",
        }[completion.type],
      }),
    );
  }
  if (
    legacy &&
    (legacy.status !== BILLING_STATUS.DRAFT ||
      legacy.source !== TIME_ENTRY_SOURCE.TIMER)
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "timer_original_entry_changed",
        message: "The original timer entry has changed",
        hint: {
          admin:
            "Ask the timer owner to discard it and review the original time entry.",
          owner: "Discard the timer and review the original time entry.",
        }[completion.type],
      }),
    );
  }
  if (completion.type === "admin" && timer.state !== "running") {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "timer_not_running",
        message: "Timer is not running",
        hint: "List running timers before ending a timer.",
      }),
    );
  }
  const narrativeFromAdmin =
    completion.type === "admin" &&
    !timer.description?.trim() &&
    completion.narrative !== undefined;
  let narrative = timer.description ?? "";
  if (completion.type === "admin" && !narrative.trim()) {
    narrative = completion.narrative ?? "";
  }
  const preparedResult = await prepareTimer({
    tx,
    owner,
    timer,
    legacy,
    memberRole,
    narrative,
    workspaceId,
    policy,
    now: new Date(),
    completion,
  });
  if (preparedResult.isErr()) {
    return Result.err(preparedResult.error);
  }
  const preparedEntry = preparedResult.value;
  const entryResult = await insertTimerEntry({
    tx,
    owner,
    workspaceId,
    legacy,
    preparedEntry,
    recordAuditEvent,
  });
  if (entryResult.isErr()) {
    return entryResult;
  }
  const entry = entryResult.value;
  return await finishTimerConfirmation({
    tx,
    owner,
    recordAuditEvent,
    completion,
    timer,
    legacy,
    workspaceId,
    entryId: entry.id,
    preparedEntry,
    narrativeFromAdmin,
  });
};

export const finalizeTimer = async ({ tx, ...options }: FinalizeTimerOptions) =>
  await withResultSavepoint(
    tx,
    async (savepoint) =>
      await finalizeTimerInSavepoint({ tx: savepoint, ...options }),
  );
