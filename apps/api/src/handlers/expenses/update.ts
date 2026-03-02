import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { expenseCategorySchema } from "@/api/db/billing-validators";
import { BILLING_STATUS, expenses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

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
  workspaceId: SafeId<"workspace">;
  body: UpdateExpenseBodySchema;
};

export const updateExpenseHandler = async ({
  workspaceId,
  body,
}: UpdateExpenseHandlerProps) => {
  const existing = await db.query.expenses.findFirst({
    where: {
      id: body.id,
      workspaceId,
    },
    columns: {
      status: true,
    },
  });

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

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (body.dateIncurred !== undefined) {
    updates.dateIncurred = body.dateIncurred;
  }
  if (body.amount !== undefined) {
    updates.amount = body.amount;
  }
  if (body.currency !== undefined) {
    updates.currency = body.currency;
  }
  if (body.category !== undefined) {
    updates.category = body.category;
  }
  if (body.description !== undefined) {
    updates.description = body.description;
  }
  if (body.invoiceDescription !== undefined) {
    updates.invoiceDescription = body.invoiceDescription;
  }
  if (body.billable !== undefined) {
    updates.billable = body.billable;
  }
  if (body.markup !== undefined) {
    updates.markup = body.markup;
  }
  if (body.matterId !== undefined) {
    const matter = await db.query.entities.findFirst({
      where: { id: body.matterId, workspaceId },
      columns: { id: true },
    });

    if (!matter) {
      return status(400, {
        message: "Matter not found in this workspace",
      });
    }

    updates.matterId = body.matterId;
  }
  if (body.status !== undefined) {
    updates.status = body.status;
  }

  await db
    .update(expenses)
    .set(updates)
    .where(
      and(eq(expenses.id, body.id), eq(expenses.workspaceId, workspaceId)),
    );

  return { id: body.id };
};
