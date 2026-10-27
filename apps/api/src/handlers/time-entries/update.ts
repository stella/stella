import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import { BILLING_STATUS } from "@stll/api-contract";
import { apiDateSchema } from "@stll/api-contract/api-date";

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
import { recordBillingCapCrossingsForMatters } from "@/api/lib/billing/arrangements";
import { narrativeLanguageSchema } from "@/api/lib/billing/narrative-language";
import { resolveRate } from "@/api/lib/billing/rates";
import {
  canApproveTimeEntries,
  canManageTimeEntry,
} from "@/api/lib/billing/time-entry-authorization";
import {
  guardTimeEntryMove,
  timeEntryMoveStatusError,
  timeEntryMoveTargetError,
} from "@/api/lib/billing/time-entry-move";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { pickDefined } from "@/api/lib/pick-defined";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const updateTimeEntryBodySchema = v.object({
  id: resourceIdSchema("timeEntry"),
  dateWorked: v.optional(apiDateSchema),
  timezoneId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  durationMinutes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  narrative: v.optional(
    v.pipe(v.string(), v.minLength(0), v.maxLength(10_000)),
  ),
  narrativeLanguage: v.optional(narrativeLanguageSchema),
  invoiceNarrative: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(10_000))),
  ),
  billable: v.optional(v.boolean()),
  noCharge: v.optional(v.boolean()),
  workItemId: v.optional(v.nullable(resourceIdSchema("entity"))),
  taskCode: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(20)))),
  activityCode: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(20)))),
});

// The route also moves a draft to another matter; the shared handler takes
// that target only once the route has checked the actor can use it.
const updateTimeEntryRouteBodySchema = v.object({
  ...updateTimeEntryBodySchema.entries,
  moveToWorkspaceId: v.optional(resourceIdSchema("workspace")),
});

export type UpdateTimeEntryHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  actor: {
    userId: SafeId<"user">;
    memberRole: AuthorizedMemberRole;
  };
  recordAuditEvent: AuditRecorder;
  body: v.InferOutput<typeof updateTimeEntryBodySchema>;
  /**
   * The matter a draft moves to, which the caller has already confirmed the
   * actor can use. Rate and currency then come from its rate table.
   */
  moveTo?: SafeId<"workspace"> | undefined;
};

type ResolvedRateUpdate =
  | { type: "unchanged" }
  | {
      type: "resolved";
      rateAtEntry: ReturnType<typeof cents>;
      currency: string;
    };

/** Why the actor cannot edit this entry, or move it, if they cannot. */
const editRefusal = ({
  existing,
  actor,
  moving,
}: {
  existing: { status: string; userId: SafeId<"user"> | null };
  actor: UpdateTimeEntryHandlerProps["actor"];
  moving: boolean;
}): HandlerError | null => {
  if (
    !canManageTimeEntry({
      memberRole: actor.memberRole,
      currentUserId: actor.userId,
      entryUserId: existing.userId,
    })
  ) {
    return new HandlerError({ status: 404, message: "Time entry not found" });
  }
  if (
    existing.status !== BILLING_STATUS.DRAFT &&
    !canApproveTimeEntries(actor.memberRole)
  ) {
    return new HandlerError({
      status: 400,
      message: "Only draft time entries can be edited",
    });
  }
  if (
    existing.status === BILLING_STATUS.BILLED ||
    existing.status === BILLING_STATUS.WRITTEN_OFF
  ) {
    return new HandlerError({
      status: 400,
      message: "Cannot edit a billed or written-off entry",
    });
  }
  return moving ? timeEntryMoveStatusError(existing.status) : null;
};

// The rate an edit leaves the entry at. Making it billable, moving its date
// or pricing an unpriced entry re-resolves the rate; a moved entry is priced
// by its new matter's rate table, billable or not. A billable entry needs a
// rate, so finding none refuses the edit.
const rateUpdateFor = async function* ({
  safeDb,
  workspaceId,
  existing,
  billable,
  changedDateWorked,
  moving,
}: {
  safeDb: SafeDb;
  /** The matter the entry ends up in. */
  workspaceId: SafeId<"workspace">;
  existing: {
    billable: boolean;
    currency: string;
    dateWorked: string;
    userId: string | null;
  };
  billable: boolean | undefined;
  changedDateWorked: string | null;
  moving: boolean;
}) {
  const willBeBillable = billable ?? existing.billable;
  const reprice =
    moving ||
    (willBeBillable &&
      (existing.currency === UNPRICED_TIME_ENTRY_CURRENCY ||
        changedDateWorked !== null ||
        (billable === true && !existing.billable)));
  if (!reprice) {
    const unchanged: ResolvedRateUpdate = { type: "unchanged" };
    return unchanged;
  }
  const resolved =
    existing.userId === null
      ? null
      : yield* resolveRate({
          safeDb,
          workspaceId,
          userId: brandPersistedUserId(existing.userId),
          dateWorked: changedDateWorked ?? existing.dateWorked,
        });
  if (resolved !== null) {
    const priced: ResolvedRateUpdate = {
      type: "resolved",
      rateAtEntry: cents(resolved.hourlyRate),
      currency: resolved.currency,
    };
    return priced;
  }
  if (willBeBillable) {
    return new HandlerError({
      status: 400,
      message:
        existing.userId === null
          ? "Billable time entries need an assigned timekeeper"
          : "Billable time entries need an effective rate",
    });
  }
  const unpriced: ResolvedRateUpdate = {
    type: "resolved",
    rateAtEntry: cents(0),
    currency: UNPRICED_TIME_ENTRY_CURRENCY,
  };
  return unpriced;
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
  moveTo,
}: UpdateTimeEntryHandlerProps) {
  const targetWorkspaceId = moveTo ?? workspaceId;
  const moving = targetWorkspaceId !== workspaceId;
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

  const refusal = editRefusal({ existing, actor, moving });
  if (refusal) {
    return Result.err(refusal);
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
            workspaceId: { eq: targetWorkspaceId },
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

  const resolvedRateUpdate = yield* rateUpdateFor({
    safeDb,
    workspaceId: targetWorkspaceId,
    existing,
    billable: body.billable,
    changedDateWorked,
    moving,
  });
  if (HandlerError.is(resolvedRateUpdate)) {
    return Result.err(resolvedRateUpdate);
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
    // A work item belongs to its matter, so a move leaves the old one behind.
    ...(moving
      ? {
          workspaceId: targetWorkspaceId,
          ...(body.workItemId === undefined ? { workItemId: null } : {}),
        }
      : {}),
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
        ...(moving ? { additionalWorkspaceIds: [targetWorkspaceId] } : {}),
        selection: { type: "entries", ids: [body.id] },
        actorUserId: actor.userId,
      });
      if (runningError) {
        return runningError;
      }
      const moveError = moving
        ? await guardTimeEntryMove(tx, {
            entryId: body.id,
            from: workspaceId,
            to: targetWorkspaceId,
          })
        : null;
      if (moveError) {
        return moveError;
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
        changes: buildTimeEntryDiff({ ...existing, workspaceId }, updates),
      });
      await recordBillingCapCrossingsForMatters(tx, {
        workspaceIds: [workspaceId, targetWorkspaceId],
        recordAuditEvent,
      });
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
    contract: "patch",
    description:
      "Change one time entry's date worked, duration, narratives, billable " +
      "and no-charge flags, work item, or task and activity codes. Editing " +
      "someone else's entry, or any entry past draft, requires time-entry " +
      "approval access, and billed or written-off entries are always " +
      "refused. Making an entry billable or moving its date re-resolves the " +
      "rate and fails when none applies. The write is conditional on the " +
      "entry being unchanged since it was read, so a concurrent edit returns " +
      "a conflict instead of overwriting. A draft can move to another " +
      "active matter you can access (moveToWorkspaceId): its rate and currency " +
      "come from that matter's rates, its work item is cleared unless one " +
      "in the new matter is given, and an entry on an invoice or with a " +
      "running timer is refused.",
    permissions: { timeEntry: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: timeEntryRealtimeUpdates,
    mcp: { type: "covered", by: "save_time_entry" },
    body: updateTimeEntryRouteBodySchema,
  },
  async function* ({
    memberRole,
    safeDb,
    user,
    workspaceId,
    body,
    recordAuditEvent,
    getWorkspaceAccess,
  }) {
    const { moveToWorkspaceId, ...fields } = body;
    // The target is the matter access confirms, never the requested id.
    const target =
      moveToWorkspaceId === undefined
        ? null
        : await getWorkspaceAccess(moveToWorkspaceId);
    const targetError =
      moveToWorkspaceId === undefined ? null : timeEntryMoveTargetError(target);
    if (targetError) {
      return Result.err(targetError);
    }
    return yield* updateTimeEntryHandler({
      safeDb,
      workspaceId,
      actor: { userId: user.id, memberRole },
      recordAuditEvent,
      body: fields,
      moveTo: target?.id,
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
