import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, expenses } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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
  async function* ({ safeDb, workspaceId, body }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.expenses.findFirst({
          where: {
            id: { eq: body.id },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            status: true,
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
        safeDb((tx) =>
          tx
            .delete(expenses)
            .where(
              and(
                eq(expenses.id, body.id),
                eq(expenses.workspaceId, workspaceId),
              ),
            ),
        ),
      );
      return Result.ok({ deleted: true });
    }

    // Non-draft expenses get written off instead of deleted
    yield* Result.await(
      safeDb((tx) =>
        tx
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
          ),
      ),
    );

    return Result.ok({ deleted: false });
  },
);

export default deleteExpense;
