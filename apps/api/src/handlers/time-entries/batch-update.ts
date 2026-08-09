import { Result } from "better-result";
import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/handlers/time-entries/constants";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const batchUpdateBodySchema = t.Object({
  ids: t.Array(tSafeId("timeEntry"), { minItems: 1, maxItems: 200 }),
  action: t.UnionEnum([
    "approve",
    "revert_to_draft",
    "mark_billable",
    "mark_non_billable",
  ]),
});

type BatchAction =
  | "approve"
  | "revert_to_draft"
  | "mark_billable"
  | "mark_non_billable";

const buildBatchEvents = (
  rows: { id: SafeId<"timeEntry"> }[],
  action: BatchAction,
): AuditEvent[] => {
  const changes = batchChangesFor(action);
  return rows.map((row) => ({
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
    resourceId: row.id,
    changes,
  }));
};

const batchChangesFor = (
  action: BatchAction,
): Record<string, { old: unknown; new: unknown }> => {
  if (action === "approve") {
    return {
      status: {
        old: BILLING_STATUS.DRAFT,
        new: BILLING_STATUS.APPROVED,
      },
    };
  }
  if (action === "revert_to_draft") {
    return {
      status: {
        old: BILLING_STATUS.APPROVED,
        new: BILLING_STATUS.DRAFT,
      },
    };
  }
  if (action === "mark_billable") {
    return { billable: { old: false, new: true } };
  }
  return { billable: { old: true, new: false } };
};

const batchUpdate = createSafeHandler(
  {
    permissions: { timeEntry: ["approve"] },
    mcp: { type: "capability", reason: "billing_admin" },
    access: "write",
    body: batchUpdateBodySchema,
  },
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const { ids, action } = body;

    const condition = and(
      eq(timeEntries.workspaceId, workspaceId),
      inArray(timeEntries.id, ids),
    );

    switch (action) {
      case "approve": {
        const rows = yield* Result.await(
          safeDb(async (tx) => {
            const blockers = await tx
              .select({
                billable: timeEntries.billable,
                currency: timeEntries.currency,
                timerStartedAt: timeEntries.timerStartedAt,
              })
              .from(timeEntries)
              .where(
                and(
                  condition,
                  eq(timeEntries.status, BILLING_STATUS.DRAFT),
                  or(
                    and(
                      eq(timeEntries.billable, true),
                      eq(
                        timeEntries.currency,
                        UNPRICED_TIME_ENTRY_CURRENCY,
                      ),
                    ),
                    isNotNull(timeEntries.timerStartedAt),
                  ),
                ),
              )
              .limit(ids.length);
            if (blockers.some((entry) => entry.timerStartedAt !== null)) {
              return { type: "running_timer" as const, rows: [] };
            }
            if (
              blockers.some(
                (entry) =>
                  entry.billable &&
                  entry.currency === UNPRICED_TIME_ENTRY_CURRENCY,
              )
            ) {
              return { type: "unpriced" as const, rows: [] };
            }
            const updated = await tx
              .update(timeEntries)
              .set({ status: BILLING_STATUS.APPROVED, updatedAt: new Date() })
              .where(
                and(condition, eq(timeEntries.status, BILLING_STATUS.DRAFT)),
              )
              .returning({ id: timeEntries.id });
            await recordAuditEvent(tx, buildBatchEvents(updated, action));
            return { type: "updated" as const, rows: updated };
          }),
        );
        if (rows.type === "unpriced") {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Billable time entries need a rate before approval",
            }),
          );
        }
        if (rows.type === "running_timer") {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Stop running timers before approval",
            }),
          );
        }
        return Result.ok({ updated: rows.rows.length });
      }

      case "revert_to_draft": {
        const rows = yield* Result.await(
          safeDb(async (tx) => {
            const updated = await tx
              .update(timeEntries)
              .set({ status: BILLING_STATUS.DRAFT, updatedAt: new Date() })
              .where(
                and(condition, eq(timeEntries.status, BILLING_STATUS.APPROVED)),
              )
              .returning({ id: timeEntries.id });
            await recordAuditEvent(tx, buildBatchEvents(updated, action));
            return updated;
          }),
        );
        return Result.ok({ updated: rows.length });
      }

      case "mark_billable": {
        const rows = yield* Result.await(
          safeDb(async (tx) => {
            const updated = await tx
              .update(timeEntries)
              .set({ billable: true, updatedAt: new Date() })
              .where(
                and(
                  condition,
                  ne(timeEntries.status, BILLING_STATUS.BILLED),
                  ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
                ),
              )
              .returning({ id: timeEntries.id });
            await recordAuditEvent(tx, buildBatchEvents(updated, action));
            return updated;
          }),
        );
        return Result.ok({ updated: rows.length });
      }

      case "mark_non_billable": {
        const rows = yield* Result.await(
          safeDb(async (tx) => {
            const updated = await tx
              .update(timeEntries)
              .set({ billable: false, updatedAt: new Date() })
              .where(
                and(
                  condition,
                  ne(timeEntries.status, BILLING_STATUS.BILLED),
                  ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
                ),
              )
              .returning({ id: timeEntries.id });
            await recordAuditEvent(tx, buildBatchEvents(updated, action));
            return updated;
          }),
        );
        return Result.ok({ updated: rows.length });
      }

      default:
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid action" }),
        );
    }
  },
);

export default batchUpdate;
