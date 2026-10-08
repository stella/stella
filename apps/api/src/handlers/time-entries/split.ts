import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { timeEntryRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { apportionSplitDurations } from "@/api/handlers/time-entries/split-durations";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import {
  getTimePolicyViolation,
  readTimePolicy,
  roundToBillingIncrement,
} from "@/api/lib/billing-time";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const splitEntryBodySchema = t.Object({
  id: tSafeId("timeEntry"),
  splits: t.Array(
    t.Object({
      workItemId: tSafeId("entity"),
      percentage: t.Integer({ minimum: 1, maximum: 100 }),
    }),
    { minItems: 2, maxItems: 10 },
  ),
});

const splitEntry = createSafeHandler(
  {
    description:
      "Split one time entry across several work items by percentage, between " +
      "2 and 10 parts totalling 100. The original entry is deleted and " +
      "replaced by new entries that share a splitGroupId and inherit its " +
      "date, rate, narrative, codes, and status, with the minutes " +
      "apportioned and re-rounded to the billing increment. A billed or " +
      "written-off entry, and a duration too short to divide, are refused.",
    permissions: { timeEntry: ["approve"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: timeEntryRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "write",
    body: splitEntryBodySchema,
  },
  async function* ({
    safeDb,
    session,
    user,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    const totalPercentage = body.splits.reduce(
      (sum, s) => sum + s.percentage,
      0,
    );

    if (totalPercentage !== 100) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Split percentages must total 100",
        }),
      );
    }

    const original = yield* Result.await(
      safeDb((tx) =>
        tx.query.timeEntries.findFirst({
          where: {
            id: { eq: body.id },
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );

    if (!original) {
      return Result.err(
        new HandlerError({ status: 404, message: "Time entry not found" }),
      );
    }

    if (
      original.status === BILLING_STATUS.BILLED ||
      original.status === BILLING_STATUS.WRITTEN_OFF
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot split a billed or written-off entry",
        }),
      );
    }

    const policy = yield* Result.await(
      readTimePolicy({
        safeDb,
        organizationId: session.activeOrganizationId,
      }),
    );
    const today = yield* formatTodayInTimeZone({
      timezoneId: original.timezoneId,
    });
    const violation = getTimePolicyViolation({
      policy,
      dateWorked: original.dateWorked,
      today,
      canApprove: true,
      narrative: original.narrative,
    });
    if (violation) {
      return Result.err(violation);
    }

    if (original.durationMinutes < body.splits.length) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Entry duration too short to split into " +
            `${body.splits.length} parts`,
        }),
      );
    }

    const targetWorkItemIds = body.splits.map((split) => split.workItemId);
    const targetWorkItems = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findMany({
          where: {
            id: { in: targetWorkItemIds },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
          limit: body.splits.length,
        }),
      ),
    );
    const foundWorkItemIds = new Set(targetWorkItems.map((item) => item.id));
    const missingWorkItemId = targetWorkItemIds.find(
      (workItemId) => !foundWorkItemIds.has(workItemId),
    );
    if (missingWorkItemId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Work item ${missingWorkItemId} not found`,
        }),
      );
    }

    const splitGroupId = createSafeId<"timeEntry">();
    const now = new Date();
    const newEntryIds: SafeId<"timeEntry">[] = [];

    const durations = apportionSplitDurations(
      original.durationMinutes,
      body.splits.map((split) => split.percentage),
    );

    // Limit check + delete + inserts in one transaction with
    // advisory lock to prevent TOCTOU on the workspace limit.
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const runningError = await guardRunningTimeEntries({
          tx,
          workspaceId,
          selection: { type: "entries", ids: [body.id] },
          actorUserId: user.id,
        });
        if (runningError) {
          return { ok: false as const, error: runningError };
        }
        const netNew = body.splits.length - 1;
        if (netNew > 0) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
          );
          const currentCount = await tx.$count(
            timeEntries,
            eq(timeEntries.workspaceId, workspaceId),
          );
          if (currentCount + netNew > LIMITS.timeEntriesPerWorkspace) {
            return { ok: false as const };
          }
        }

        const [current] = await tx
          .select({
            id: timeEntries.id,
            status: timeEntries.status,
            updatedAt: timeEntries.updatedAt,
            approverUserId: timeEntries.approverUserId,
            approvedByUserId: timeEntries.approvedByUserId,
            approvedAt: timeEntries.approvedAt,
            returnedByUserId: timeEntries.returnedByUserId,
            returnedAt: timeEntries.returnedAt,
            returnComment: timeEntries.returnComment,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.id, body.id),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          )
          .limit(1)
          .for("update");
        if (
          !current ||
          current.status !== original.status ||
          current.updatedAt?.getTime() !== original.updatedAt?.getTime() ||
          current.approverUserId !== original.approverUserId ||
          current.approvedByUserId !== original.approvedByUserId ||
          current.approvedAt?.getTime() !== original.approvedAt?.getTime() ||
          current.returnedByUserId !== original.returnedByUserId ||
          current.returnedAt?.getTime() !== original.returnedAt?.getTime() ||
          current.returnComment !== original.returnComment
        ) {
          return {
            ok: false as const,
            error: new HandlerError({
              status: 409,
              message: "Time entry changed; reload and try again",
            }),
          };
        }
        const [deleted] = await tx
          .delete(timeEntries)
          .where(
            and(
              eq(timeEntries.id, body.id),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          )
          .returning({ id: timeEntries.id });
        if (!deleted) {
          return panic("Locked original entry deletion returned no row");
        }

        const createdEntries: {
          id: SafeId<"timeEntry">;
          workItemId: SafeId<"entity">;
          durationMinutes: number;
          billedMinutes: number;
        }[] = [];
        const successorRows: (typeof timeEntries.$inferInsert)[] = [];

        // Ids are minted here, so the successors go in as one insert and the
        // audit events below need nothing read back.
        for (let i = 0; i < body.splits.length; i++) {
          const split = body.splits[i];
          const durationMinutes = durations[i];
          if (!split || durationMinutes === undefined) {
            continue;
          }
          const billedMinutes = roundToBillingIncrement(
            durationMinutes,
            policy.timeMinimumUnitMinutes,
          );
          const entryId = createSafeId<"timeEntry">();

          successorRows.push({
            id: entryId,
            organizationId: original.organizationId,
            workspaceId,
            userId: original.userId,
            approverUserId: current.approverUserId,
            approvedByUserId: current.approvedByUserId,
            approvedAt: current.approvedAt,
            returnedByUserId: current.returnedByUserId,
            returnedAt: current.returnedAt,
            returnComment: current.returnComment,
            workItemId: split.workItemId,
            dateWorked: original.dateWorked,
            timezoneId: original.timezoneId,
            durationMinutes,
            billedMinutes,
            rateAtEntry: original.rateAtEntry,
            currency: original.currency,
            narrative: original.narrative,
            narrativeLanguage: original.narrativeLanguage,
            invoiceNarrative: original.invoiceNarrative,
            billable: original.billable,
            noCharge: original.noCharge,
            status: original.status,
            source: original.source,
            taskCode: original.taskCode,
            activityCode: original.activityCode,
            splitGroupId,
            createdAt: now,
            updatedAt: now,
          });

          newEntryIds.push(entryId);
          createdEntries.push({
            id: entryId,
            workItemId: split.workItemId,
            durationMinutes,
            billedMinutes,
          });
        }

        if (successorRows.length > 0) {
          await tx.insert(timeEntries).values(successorRows);
        }

        const events: AuditEvent[] = [
          {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
            resourceId: body.id,
            changes: {
              deleted: {
                old: {
                  workItemId: original.workItemId,
                  durationMinutes: original.durationMinutes,
                  billedMinutes: original.billedMinutes,
                  reason: "split",
                  splitGroupId,
                },
                new: null,
              },
            },
          },
          ...createdEntries.map((row) => ({
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
            resourceId: row.id,
            changes: {
              created: {
                old: null,
                new: {
                  workItemId: row.workItemId,
                  durationMinutes: row.durationMinutes,
                  billedMinutes: row.billedMinutes,
                  splitGroupId,
                  splitFrom: body.id,
                },
              },
            },
          })),
        ];

        await recordAuditEvent(tx, events);
        await recordBillingCapCrossings(tx, { workspaceId, recordAuditEvent });

        return { ok: true as const };
      }),
    );

    if (!txResult.ok) {
      if ("error" in txResult) {
        return Result.err(txResult.error);
      }
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Workspace time entry limit reached",
        }),
      );
    }

    return Result.ok({ splitGroupId, entryIds: newEntryIds });
  },
);

export default splitEntry;
