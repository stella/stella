import { eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { expenseCategorySchema } from "@/api/db/billing-validators";
import { expenses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createExpenseBodySchema = t.Object({
  matterId: tNanoid,
  dateIncurred: t.String({ format: "date" }),
  timezoneId: t.String({ minLength: 1, maxLength: 64 }),
  amount: t.Integer({ minimum: 1 }),
  currency: t.String({ minLength: 3, maxLength: 3 }),
  category: expenseCategorySchema,
  description: t.String({ minLength: 1, maxLength: 10_000 }),
  invoiceDescription: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  billable: t.Optional(t.Boolean()),
  markup: t.Optional(t.Integer({ minimum: 0, maximum: 100 })),
});

type CreateExpenseBodySchema = Static<typeof createExpenseBodySchema>;

type CreateExpenseHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: string;
  body: CreateExpenseBodySchema;
};

export const createExpenseHandler = async ({
  scopedDb,
  organizationId,
  workspaceId,
  userId,
  body,
}: CreateExpenseHandlerProps) => {
  const now = new Date();
  // en-CA locale formats dates as YYYY-MM-DD (ISO 8601)
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: body.timezoneId,
  }).format(now);
  const dateIncurred = new Date(`${body.dateIncurred}T00:00:00`);
  const today = new Date(`${todayStr}T00:00:00`);

  if (dateIncurred > today) {
    return status(400, {
      message: "Date incurred cannot be in the future",
    });
  }

  const maxAgeCutoff = new Date(today);
  maxAgeCutoff.setDate(maxAgeCutoff.getDate() - LIMITS.timeEntryMaxAgeDays);
  if (dateIncurred < maxAgeCutoff) {
    return status(400, {
      message: `Date incurred cannot be more than ${LIMITS.timeEntryMaxAgeDays} days ago`,
    });
  }

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

  const totalExpenses = await scopedDb((tx) =>
    tx.$count(expenses, eq(expenses.workspaceId, workspaceId)),
  );

  if (totalExpenses >= LIMITS.expensesPerWorkspace) {
    return status(400, {
      message: "Expenses limit reached for this workspace",
    });
  }

  const [entry] = await scopedDb((tx) =>
    tx
      .insert(expenses)
      .values({
        organizationId,
        workspaceId,
        userId,
        matterId: body.matterId,
        dateIncurred: body.dateIncurred,
        amount: body.amount,
        currency: body.currency,
        category: body.category,
        description: body.description,
        invoiceDescription: body.invoiceDescription ?? null,
        billable: body.billable ?? true,
        markup: body.markup ?? 0,
      })
      .returning({ id: expenses.id }),
  );

  return { id: entry.id };
};
