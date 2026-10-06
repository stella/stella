import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { BILLING_STATUS } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { timeEntries } from "@/api/db/schema";
import { timeEntryRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import {
  getTimePolicyViolation,
  readTimePolicy,
  roundToBillingIncrement,
} from "@/api/lib/billing-time";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import { narrativeLanguageSchema } from "@/api/lib/billing/narrative-language";
import { resolveRate } from "@/api/lib/billing/rates";
import {
  canApproveTimeEntries,
  canManageTimeEntry,
} from "@/api/lib/billing/time-entry-authorization";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { pickDefined } from "@/api/lib/pick-defined";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const updateTimeEntryBodySchema = t.Object({
  id: tSafeId("timeEntry"),
  dateWorked: t.Optional(t.String({ format: "date" })),
  timezoneId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  durationMinutes: t.Optional(t.Integer({ minimum: 1 })),
  narrative: t.Optional(t.String({ minLength: 0, maxLength: 10_000 })),
  narrativeLanguage: t.Optional(narrativeLanguageSchema),
  invoiceNarrative: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  billable: t.Optional(t.Boolean()),
  noCharge: t.Optional(t.Boolean()),
  workItemId: t.Optional(t.Nullable(tSafeId("entity"))),
  taskCode: t.Optional(t.Nullable(t.String({ maxLength: 20 }))),
  activityCode: t.Optional(t.Nullable(t.String({ maxLength: 20 }))),
});

export type UpdateTimeEntryHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  actor: {
    userId: SafeId<"user">;
    memberRole: AuthorizedMemberRole;
  };
  recordAuditEvent: AuditRecorder;
  body: Static<typeof updateTimeEntryBodySchema>;
};

type ResolvedRateUpdate =
  | { type: "unchanged" }
  | {
      type: "resolved";
      rateAtEntry: ReturnType<typeof cents>;
      currency: string;
    };

// Shared time-entry update logic reused by the HTTP handler and the
// `save_time_entry` MCP tool, so both enforce the billed/written-off guard and
// emit the same audit diff.
export const updateTimeEntryHandler = async function* ({
  safeDb,
  workspaceId,
  actor,
  recordAuditEvent,
  body,
}: UpdateTimeEntryHandlerProps) {
  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.timeEntries.findFirst({
        where: {
          id: { eq: body.id },
          workspaceId: { eq: workspaceId },
        },
        columns: {
          organizationId: true,
          status: true,
          dateWorked: true,
          timezoneId: true,
          durationMinutes: true,
          billedMinutes: true,
          narrative: true,
          narrativeLanguage: true,
          invoiceNarrative: true,
          billable: true,
          noCharge: true,
          workItemId: true,
          userId: true,
          taskCode: true,
          activityCode: true,
          rateAtEntry: true,
          currency: true,
        },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Time entry not found" }),
    );
  }

  if (
    !canManageTimeEntry({
      memberRole: actor.memberRole,
      currentUserId: actor.userId,
      entryUserId: existing.userId,
    })
  ) {
    return Result.err(
      new HandlerError({ status: 404, message: "Time entry not found" }),
    );
  }

  if (
    existing.status !== BILLING_STATUS.DRAFT &&
    !canApproveTimeEntries(actor.memberRole)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Only draft time entries can be edited",
      }),
    );
  }

  if (
    existing.status === BILLING_STATUS.BILLED ||
    existing.status === BILLING_STATUS.WRITTEN_OFF
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Cannot edit a billed or written-off entry",
      }),
    );
  }

  const policy = yield* Result.await(
    readTimePolicy({ safeDb, organizationId: existing.organizationId }),
  );
  const existingToday = yield* formatTodayInTimeZone({
    timezoneId: existing.timezoneId,
  });
  const canApprove = canApproveTimeEntries(actor.memberRole);
  const existingViolation = getTimePolicyViolation({
    policy,
    dateWorked: existing.dateWorked,
    today: existingToday,
    canApprove,
    narrative: body.narrative ?? existing.narrative,
  });
  if (existingViolation) {
    return Result.err(existingViolation);
  }

  const changedDateWorked =
    body.dateWorked !== undefined && body.dateWorked !== existing.dateWorked
      ? body.dateWorked
      : null;
  let changedTimezoneId: string | null = null;
  if (changedDateWorked !== null) {
    if (body.timezoneId === undefined) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Time zone is required when changing date worked",
        }),
      );
    }
    const changedToday = yield* formatTodayInTimeZone({
      timezoneId: body.timezoneId,
    });
    const dateValidationError = getTimePolicyViolation({
      policy,
      dateWorked: changedDateWorked,
      today: changedToday,
      canApprove,
    });
    if (dateValidationError) {
      return Result.err(dateValidationError);
    }
    changedTimezoneId = body.timezoneId;
  }

  const workItemId = body.workItemId;
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
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Work item not found in this matter",
        }),
      );
    }
  }

  const willBeBillable = body.billable ?? existing.billable;
  const becomingBillable = body.billable === true && !existing.billable;
  const shouldResolveRate =
    willBeBillable &&
    (existing.currency === UNPRICED_TIME_ENTRY_CURRENCY ||
      changedDateWorked !== null ||
      becomingBillable);
  let resolvedRateUpdate: ResolvedRateUpdate = { type: "unchanged" };
  if (shouldResolveRate) {
    if (!existing.userId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Billable time entries need an assigned timekeeper",
        }),
      );
    }

    const resolvedRate = yield* resolveRate({
      safeDb,
      workspaceId,
      userId: brandPersistedUserId(existing.userId),
      dateWorked: changedDateWorked ?? existing.dateWorked,
    });
    if (!resolvedRate) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Billable time entries need an effective rate",
        }),
      );
    }
    resolvedRateUpdate = {
      type: "resolved",
      rateAtEntry: cents(resolvedRate.hourlyRate),
      currency: resolvedRate.currency,
    };
  }

  const updates = {
    ...pickDefined(body, [
      "dateWorked",
      "durationMinutes",
      "narrative",
      "narrativeLanguage",
      "invoiceNarrative",
      "billable",
      "noCharge",
      "workItemId",
      "taskCode",
      "activityCode",
    ]),
    ...(changedTimezoneId !== null ? { timezoneId: changedTimezoneId } : {}),
    ...(body.durationMinutes !== undefined
      ? {
          billedMinutes: roundToBillingIncrement(
            body.durationMinutes,
            policy.timeMinimumUnitMinutes,
          ),
        }
      : {}),
    ...(resolvedRateUpdate.type === "resolved"
      ? {
          rateAtEntry: resolvedRateUpdate.rateAtEntry,
          currency: resolvedRateUpdate.currency,
        }
      : {}),
    updatedAt: new Date(),
  };

  const updated = yield* Result.await(
    safeDb(async (tx) => {
      const runningError = await guardRunningTimeEntries({
        tx,
        workspaceId,
        selection: { type: "entries", ids: [body.id] },
        actorUserId: actor.userId,
      });
      if (runningError) {
        return runningError;
      }
      const rows = await tx
        .update(timeEntries)
        .set(updates)
        .where(
          and(
            eq(timeEntries.id, body.id),
            eq(timeEntries.workspaceId, workspaceId),
            eq(timeEntries.status, existing.status),
            eq(timeEntries.dateWorked, existing.dateWorked),
            eq(timeEntries.timezoneId, existing.timezoneId),
            eq(timeEntries.durationMinutes, existing.durationMinutes),
            eq(timeEntries.billedMinutes, existing.billedMinutes),
            eq(timeEntries.narrative, existing.narrative),
            existing.narrativeLanguage === null
              ? isNull(timeEntries.narrativeLanguage)
              : eq(timeEntries.narrativeLanguage, existing.narrativeLanguage),
            existing.invoiceNarrative === null
              ? isNull(timeEntries.invoiceNarrative)
              : eq(timeEntries.invoiceNarrative, existing.invoiceNarrative),
            eq(timeEntries.billable, existing.billable),
            eq(timeEntries.noCharge, existing.noCharge),
            existing.workItemId === null
              ? isNull(timeEntries.workItemId)
              : eq(timeEntries.workItemId, existing.workItemId),
            existing.taskCode === null
              ? isNull(timeEntries.taskCode)
              : eq(timeEntries.taskCode, existing.taskCode),
            existing.activityCode === null
              ? isNull(timeEntries.activityCode)
              : eq(timeEntries.activityCode, existing.activityCode),
            eq(timeEntries.rateAtEntry, existing.rateAtEntry),
            eq(timeEntries.currency, existing.currency),
            canApproveTimeEntries(actor.memberRole)
              ? undefined
              : eq(timeEntries.userId, actor.userId),
          ),
        )
        .returning({ id: timeEntries.id });

      if (!rows.at(0)) {
        return false;
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
        resourceId: body.id,
        changes: buildTimeEntryDiff(existing, updates),
      });
      await recordBillingCapCrossings(tx, { workspaceId, recordAuditEvent });
      return true;
    }),
  );

  if (HandlerError.is(updated)) {
    return Result.err(updated);
  }
  if (!updated) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Time entry changed; reload and try again",
      }),
    );
  }

  return Result.ok({ id: body.id });
};

const updateTimeEntryById = createSafeHandler(
  {
    description:
      "Change one time entry's date worked, duration, narratives, billable " +
      "and no-charge flags, work item, or task and activity codes. Editing " +
      "someone else's entry, or any entry past draft, requires time-entry " +
      "approval access, and billed or written-off entries are always " +
      "refused. Making an entry billable or moving its date re-resolves the " +
      "rate and fails when none applies. The write is conditional on the " +
      "entry being unchanged since it was read, so a concurrent edit returns " +
      "a conflict instead of overwriting.",
    permissions: { timeEntry: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: timeEntryRealtimeUpdates,
    mcp: { type: "covered", by: "save_time_entry" },
    body: updateTimeEntryBodySchema,
  },
  async function* ({
    memberRole,
    safeDb,
    user,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    return yield* updateTimeEntryHandler({
      safeDb,
      workspaceId,
      actor: { userId: user.id, memberRole },
      recordAuditEvent,
      body,
    });
  },
);

// Free-text client notes; excluded from the audit diff so they are
// never persisted into `audit_logs`. Matches create.ts, which omits
// `narrative` from the CREATE audit event for the same reason.
const TIME_ENTRY_DIFF_EXCLUDED_FIELDS = new Set([
  "updatedAt",
  "narrative",
  "invoiceNarrative",
]);

const buildTimeEntryDiff = (
  before: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, { old: unknown; new: unknown }> => {
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (TIME_ENTRY_DIFF_EXCLUDED_FIELDS.has(key)) {
      continue;
    }
    diff[key] = { old: before[key] ?? null, new: value };
  }
  return diff;
};

export default updateTimeEntryById;
