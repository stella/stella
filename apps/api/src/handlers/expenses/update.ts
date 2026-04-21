import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { expenseCategorySchema } from "@/api/db/billing-validators";
import { BILLING_STATUS, expenses } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const updateExpenseBodySchema = t.Object({
  id: tUuid,
  dateIncurred: t.Optional(t.String({ format: "date" })),
  amount: t.Optional(t.Integer({ minimum: 1 })),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  category: t.Optional(expenseCategorySchema),
  description: t.Optional(t.String({ minLength: 1, maxLength: 10_000 })),
  invoiceDescription: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  billable: t.Optional(t.Boolean()),
  markup: t.Optional(t.Integer({ minimum: 0, maximum: 100 })),
  matterId: t.Optional(tUuid),
  status: t.Optional(
    t.UnionEnum([BILLING_STATUS.DRAFT, BILLING_STATUS.APPROVED]),
  ),
});

const config = {
  permissions: { expense: ["update"] },
  body: updateExpenseBodySchema,
} satisfies HandlerConfig;

const updateExpense = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.expenses.findFirst({
          where: {
            id: body.id,
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

    if (
      existing.status === BILLING_STATUS.BILLED ||
      existing.status === BILLING_STATUS.WRITTEN_OFF
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot edit a billed or written-off expense",
        }),
      );
    }

    if (body.matterId !== undefined) {
      const matter = yield* Result.await(
        safeDb((tx) =>
          tx.query.entities.findFirst({
            where: { id: body.matterId, workspaceId: { eq: workspaceId } },
            columns: { id: true },
          }),
        ),
      );

      if (!matter) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Matter not found in this workspace",
          }),
        );
      }
    }

    const updates = {
      ...pickDefined(body, [
        "dateIncurred",
        "amount",
        "currency",
        "category",
        "description",
        "invoiceDescription",
        "billable",
        "markup",
        "matterId",
        "status",
      ]),
      updatedAt: new Date(),
    };

    yield* Result.await(
      safeDb((tx) =>
        tx
          .update(expenses)
          .set(updates)
          .where(
            and(
              eq(expenses.id, body.id),
              eq(expenses.workspaceId, workspaceId),
            ),
          ),
      ),
    );

    return Result.ok({ id: body.id });
  },
);

export default updateExpense;
