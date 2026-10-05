import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { resultTx } from "@/api/db/safe-db";
import { BILLING_STATUS, expenses } from "@/api/db/schema";
import { expenseRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteExpenseBodySchema = t.Object({
  id: tSafeId("expense"),
});

const config = {
  description:
    "Delete an expense: a draft expense is permanently deleted, and any other " +
    "unbilled expense is written off instead (kept for the audit trail, " +
    "excluded from billing). A billed expense is refused until its invoice is " +
    "reverted; the return value says which of the two happened.",
  permissions: { expense: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  realtime: expenseRealtimeUpdates,
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  body: deleteExpenseBodySchema,
} satisfies WorkspaceHandlerConfig;

const deleteExpense = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const result = yield* Result.await(
      resultTx(safeDb, async (tx) => {
        const [existing] = await tx
          .select()
          .from(expenses)
          .where(
            and(
              eq(expenses.id, body.id),
              eq(expenses.workspaceId, workspaceId),
            ),
          )
          .limit(1)
          .for("update");

        if (!existing) {
          return Result.err(
            new HandlerError({ status: 404, message: "Expense not found" }),
          );
        }

        // A billed expense is attached to an invoice; writing it off here would
        // leave the invoice total stale. Match batch-delete, which excludes BILLED.
        if (existing.status === BILLING_STATUS.BILLED) {
          return Result.err(
            new HandlerError({
              status: 400,
              message:
                "Cannot delete a billed expense; revert the invoice first",
            }),
          );
        }

        if (existing.status === BILLING_STATUS.DRAFT) {
          await tx
            .delete(expenses)
            .where(
              and(
                eq(expenses.id, body.id),
                eq(expenses.workspaceId, workspaceId),
              ),
            );

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
            resourceId: body.id,
            changes: {
              deleted: {
                old: {
                  amount: existing.amount,
                  currency: existing.currency,
                  category: existing.category,
                  matterId: existing.matterId,
                  dateIncurred: existing.dateIncurred,
                },
                new: null,
              },
            },
          });
          return Result.ok({ deleted: true });
        }

        // Non-draft expenses get written off instead of deleted
        await tx
          .update(expenses)
          .set({
            status: BILLING_STATUS.WRITTEN_OFF,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(expenses.id, body.id),
              eq(expenses.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
          resourceId: body.id,
          changes: {
            status: {
              old: existing.status,
              new: BILLING_STATUS.WRITTEN_OFF,
            },
          },
        });
        return Result.ok({ deleted: false });
      }),
    );
    return Result.ok(result);
  },
);

export default deleteExpense;
