import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, expenses } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteExpenseBodySchema = t.Object({
  id: tSafeId("expense"),
});

const config = {
  permissions: { expense: ["delete"] },
  body: deleteExpenseBodySchema,
} satisfies HandlerConfig;

const deleteExpense = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.expenses.findFirst({
          where: {
            id: { eq: body.id },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            status: true,
            amount: true,
            currency: true,
            category: true,
            matterId: true,
            dateIncurred: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Expense not found" }),
      );
    }

    if (existing.status === BILLING_STATUS.DRAFT) {
      yield* Result.await(
        safeDb(async (tx) => {
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
        }),
      );
      return Result.ok({ deleted: true });
    }

    // Non-draft expenses get written off instead of deleted
    yield* Result.await(
      safeDb(async (tx) => {
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
      }),
    );

    return Result.ok({ deleted: false });
  },
);

export default deleteExpense;
