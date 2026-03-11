import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { expenseCategorySchema } from "@/api/db/billing-validators";
import { BILLING_STATUS, expenses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { pickDefined } from "@/api/lib/pick-defined";

export const updateExpenseBodySchema = t.Object({
  id: tNanoid,
  dateIncurred: t.Optional(t.String({ format: "date" })),
  amount: t.Optional(t.Integer({ minimum: 1 })),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  category: t.Optional(expenseCategorySchema),
  description: t.Optional(t.String({ minLength: 1, maxLength: 10_000 })),
  invoiceDescription: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  billable: t.Optional(t.Boolean()),
  markup: t.Optional(t.Integer({ minimum: 0, maximum: 100 })),
  matterId: t.Optional(tNanoid),
  status: t.Optional(
    t.UnionEnum([BILLING_STATUS.DRAFT, BILLING_STATUS.APPROVED]),
  ),
});

type UpdateExpenseBodySchema = Static<typeof updateExpenseBodySchema>;

type UpdateExpenseHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  body: UpdateExpenseBodySchema;
};

export const updateExpenseHandler = async ({
  scopedDb,
  workspaceId,
  body,
}: UpdateExpenseHandlerProps) => {
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

  if (
    existing.status === BILLING_STATUS.BILLED ||
    existing.status === BILLING_STATUS.WRITTEN_OFF
  ) {
    return status(400, {
      message: "Cannot edit a billed or written-off expense",
    });
  }

  if (body.matterId !== undefined) {
    const matter = await scopedDb((tx) =>
      tx.query.entities.findFirst({
        where: { id: body.matterId, workspaceId: { eq: workspaceId } },
        columns: { id: true },
      }),
    );

    if (!matter) {
      return status(400, {
        message: "Matter not found in this workspace",
      });
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

  await scopedDb((tx) =>
    tx
      .update(expenses)
      .set(updates)
      .where(
        and(eq(expenses.id, body.id), eq(expenses.workspaceId, workspaceId)),
      ),
  );

  return { id: body.id };
};
