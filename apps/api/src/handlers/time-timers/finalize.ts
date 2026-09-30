import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

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
import { readTimePolicy } from "@/api/lib/billing-time";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import {
  insertPreparedTimeEntry,
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
  durationMinutes: timeEntries.durationMinutes,
  billedMinutes: timeEntries.billedMinutes,
};
type TimeEntryRow = typeof timeEntries.$inferSelect;
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
  "splitGroupId",
  "timerStartedAt",
  "timerStoppedAt",
  "createdAt",
  "updatedAt",
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
  | { type: "owner"; timezoneId: string; billable?: boolean | undefined }
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
  workspaceId: NonNullable<typeof timeTimers.$inferSelect.workspaceId>;
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
    const policy = yield* Result.await(
      readTimePolicy({
        safeDb: handle,
        organizationId: owner.organizationId,
      }),
    );
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
        dateWorked: legacy?.dateWorked ?? dateResult.value,
        timezoneId,
        durationMinutes,
        narrative,
        billable:
          completion.type === "owner"
            ? (completion.billable ?? legacy?.billable)
            : legacy?.billable,
        workItemId:
          legacy?.workspaceId === workspaceId ? legacy.workItemId : null,
        narrativeLanguage: legacy?.narrativeLanguage,
        taskCode: legacy?.taskCode,
        activityCode: legacy?.activityCode,
      },
    });
    return Result.ok(prepared);
  });
  if (preparedResult.isErr()) {
    return Result.err(preparedResult.error);
  }
  return Result.ok({ prepared: preparedResult.value, durationMinutes });
};

const finalizeTimerInSavepoint = async ({
  tx,
  owner,
  id,
  memberRole,
  recordAuditEvent,
  completion,
}: FinalizeTimerOptions) => {
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
  if (!workspaceId) {
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
  if (!(await hasCurrentTimerMatterAccess({ tx, ...owner, workspaceId }))) {
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
    now: new Date(),
    completion,
  });
  if (preparedResult.isErr()) {
    return Result.err(preparedResult.error);
  }
  const { prepared, durationMinutes } = preparedResult.value;
  const capacity = await lockTimeEntryCapacity({
    tx,
    workspaceId,
    replacedEntryId:
      legacy?.workspaceId === workspaceId ? legacy.id : undefined,
  });
  if (capacity.isErr()) {
    return Result.err(capacity.error);
  }
  const entry = await insertPreparedTimeEntry({
    tx,
    ...owner,
    workspaceId,
    source: TIME_ENTRY_SOURCE.TIMER,
    prepared,
    recordAuditEvent,
  });
  await tx
    .insert(timeTimerConfirmations)
    .values({ ...owner, timerId: timer.id, timeEntryId: entry.id });
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
      confirmedEntryId: { old: null, new: entry.id },
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
    id: entry.id,
    durationMinutes,
    billedMinutes: prepared.billedMinutes,
  });
};

export const finalizeTimer = async ({ tx, ...options }: FinalizeTimerOptions) =>
  await withResultSavepoint(
    tx,
    async (savepoint) =>
      await finalizeTimerInSavepoint({ tx: savepoint, ...options }),
  );
