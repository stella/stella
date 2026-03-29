import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { BILLING_STATUS, expenses } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const deleteExpenseBodySchema = t.Object({
  id: tNanoid,
});

const config = {
  permissions: { expense: ["delete"] },
  body: deleteExpenseBodySchema,
} satisfies HandlerConfig;

const deleteExpense = createHandler(
  config,
  async ({ scopedDb, workspaceId, body }) => {
    const existing = await scopedDb((tx) =>
      tx.query.expenses.findFirst({
        where: {
          id: body.id,
          workspaceId: { eq: workspaceId },
        },
        columns: {
          status: true,
        },
      }),
    );

    if (!existing) {
      return status(404, { message: "Expense not found" });
    }

    if (existing.status === BILLING_STATUS.DRAFT) {
      await scopedDb((tx) =>
        tx
          .delete(expenses)
          .where(
            and(
              eq(expenses.id, body.id),
              eq(expenses.workspaceId, workspaceId),
            ),
          ),
      );
      return { deleted: true };
    }

    // Non-draft expenses get written off instead of deleted
    await scopedDb((tx) =>
      tx
        .update(expenses)
        .set({
          status: BILLING_STATUS.WRITTEN_OFF,
          updatedAt: new Date(),
        })
        .where(
          and(eq(expenses.id, body.id), eq(expenses.workspaceId, workspaceId)),
        ),
    );

    return { deleted: false };
  },
);

export default deleteExpense;
