import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { BILLING_STATUS, expenses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const deleteExpenseBodySchema = t.Object({
  id: tNanoid,
});

type DeleteExpenseBodySchema = Static<typeof deleteExpenseBodySchema>;

type DeleteExpenseHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: DeleteExpenseBodySchema;
};

export const deleteExpenseHandler = async ({
  workspaceId,
  body,
}: DeleteExpenseHandlerProps) => {
  const existing = await db.query.expenses.findFirst({
    where: {
      id: body.id,
      workspaceId: { eq: workspaceId },
    },
    columns: {
      status: true,
    },
  });

  if (!existing) {
    return status(404, { message: "Expense not found" });
  }

  if (existing.status === BILLING_STATUS.DRAFT) {
    await db
      .delete(expenses)
      .where(
        and(eq(expenses.id, body.id), eq(expenses.workspaceId, workspaceId)),
      );
    return { deleted: true };
  }

  // Non-draft expenses get written off instead of deleted
  await db
    .update(expenses)
    .set({
      status: BILLING_STATUS.WRITTEN_OFF,
      updatedAt: new Date(),
    })
    .where(
      and(eq(expenses.id, body.id), eq(expenses.workspaceId, workspaceId)),
    );

  return { deleted: false };
};
