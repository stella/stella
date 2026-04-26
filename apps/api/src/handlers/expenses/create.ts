import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { expenseCategorySchema } from "@/api/db/billing-validators";
import { expenses } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";

const createExpenseBodySchema = t.Object({
  matterId: tSafeId("entity"),
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

const config = {
  permissions: { expense: ["create"] },
  body: createExpenseBodySchema,
} satisfies HandlerConfig;

const createExpense = createSafeHandler(
  config,
  async function* ({ safeDb, session, user, workspaceId, body }) {
    const now = new Date();
    // en-CA locale formats dates as YYYY-MM-DD (ISO 8601)
    const todayStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: body.timezoneId,
    }).format(now);
    const dateIncurred = new Date(`${body.dateIncurred}T00:00:00`);
    const today = new Date(`${todayStr}T00:00:00`);

    if (dateIncurred > today) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Date incurred cannot be in the future",
        }),
      );
    }

    const maxAgeCutoff = new Date(today);
    maxAgeCutoff.setDate(maxAgeCutoff.getDate() - LIMITS.timeEntryMaxAgeDays);
    if (dateIncurred < maxAgeCutoff) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Date incurred cannot be more than ${LIMITS.timeEntryMaxAgeDays} days ago`,
        }),
      );
    }

    const matter = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: body.matterId },
            workspaceId: { eq: workspaceId },
          },
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

    const totalExpenses = yield* Result.await(
      safeDb((tx) =>
        tx.$count(expenses, eq(expenses.workspaceId, workspaceId)),
      ),
    );

    if (totalExpenses >= LIMITS.expensesPerWorkspace) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Expenses limit reached for this workspace",
        }),
      );
    }

    const [entry] = yield* Result.await(
      safeDb((tx) =>
        tx
          .insert(expenses)
          .values({
            organizationId: session.activeOrganizationId,
            workspaceId,
            userId: user.id,
            matterId: body.matterId,
            dateIncurred: body.dateIncurred,
            amount: cents(body.amount),
            currency: body.currency,
            category: body.category,
            description: body.description,
            invoiceDescription: body.invoiceDescription ?? null,
            billable: body.billable ?? true,
            markup: body.markup ?? 0,
          })
          .returning({ id: expenses.id }),
      ),
    );

    if (!entry) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to create expense",
        }),
      );
    }
    return Result.ok({ id: entry.id });
  },
);

export default createExpense;
