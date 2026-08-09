import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import {
  canApproveTimeEntries,
  canManageTimeEntry,
} from "@/api/handlers/time-entries/authorization";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { resolveRate } from "@/api/lib/billing-rates";
import { roundToBillingIncrement } from "@/api/lib/billing-time";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { pickDefined } from "@/api/lib/pick-defined";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const updateTimeEntryBodySchema = t.Object({
  id: tSafeId("timeEntry"),
  dateWorked: t.Optional(t.String({ format: "date" })),
  durationMinutes: t.Optional(t.Integer({ minimum: 1 })),
  narrative: t.Optional(t.String({ minLength: 1, maxLength: 10_000 })),
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
          status: true,
          dateWorked: true,
          durationMinutes: true,
          billedMinutes: true,
          narrative: true,
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
  const shouldResolveRate =
    willBeBillable &&
    (existing.currency === UNPRICED_TIME_ENTRY_CURRENCY ||
      body.dateWorked !== undefined ||
      body.billable === true);
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
      dateWorked: body.dateWorked ?? existing.dateWorked,
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
      "invoiceNarrative",
      "billable",
      "noCharge",
      "workItemId",
      "taskCode",
      "activityCode",
    ]),
    ...(body.durationMinutes !== undefined
      ? { billedMinutes: roundToBillingIncrement(body.durationMinutes) }
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
      const rows = await tx
        .update(timeEntries)
        .set(updates)
        .where(
          and(
            eq(timeEntries.id, body.id),
            eq(timeEntries.workspaceId, workspaceId),
            eq(timeEntries.status, existing.status),
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
      return true;
    }),
  );

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
    permissions: { timeEntry: ["update"] },
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
