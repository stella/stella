import { Result } from "better-result";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { t } from "elysia";

import { user } from "@/api/db/auth-schema";
import {
  expenseCategorySchema,
  timeEntryStatusSchema,
} from "@/api/db/billing-validators";
import { expenses } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";

const readExpensesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
  userId: t.Optional(t.String({ minLength: 1 })),
  matterId: t.Optional(tUuid),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  status: t.Optional(timeEntryStatusSchema),
  category: t.Optional(expenseCategorySchema),
  billable: t.Optional(t.BooleanString()),
});

const config = {
  permissions: { workspace: ["read"] },
  query: readExpensesQuerySchema,
} satisfies HandlerConfig;

const readExpenses = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const conditions = [eq(expenses.workspaceId, workspaceId)];

    if (query.userId) {
      conditions.push(eq(expenses.userId, query.userId));
    }
    if (query.matterId) {
      conditions.push(eq(expenses.matterId, query.matterId));
    }
    if (query.dateFrom) {
      conditions.push(gte(expenses.dateIncurred, query.dateFrom));
    }
    if (query.dateTo) {
      conditions.push(lte(expenses.dateIncurred, query.dateTo));
    }
    if (query.status) {
      conditions.push(eq(expenses.status, query.status));
    }
    if (query.category) {
      conditions.push(eq(expenses.category, query.category));
    }
    if (query.billable !== undefined) {
      conditions.push(eq(expenses.billable, query.billable));
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: expenses.id,
            userId: expenses.userId,
            matterId: expenses.matterId,
            dateIncurred: expenses.dateIncurred,
            amount: expenses.amount,
            currency: expenses.currency,
            category: expenses.category,
            description: expenses.description,
            invoiceDescription: expenses.invoiceDescription,
            billable: expenses.billable,
            markup: expenses.markup,
            status: expenses.status,
            createdAt: expenses.createdAt,
            updatedAt: expenses.updatedAt,
          })
          .from(expenses)
          .where(and(...conditions))
          .orderBy(expenses.dateIncurred)
          .limit(limit)
          .offset(offset),
      ),
    );

    // Batch-fetch user names
    const userIds = new Set<string>();
    for (const row of rows) {
      if (row.userId) {
        userIds.add(row.userId);
      }
    }

    const usersResult =
      userIds.size > 0
        ? yield* Result.await(
            safeDb((tx) =>
              tx
                .select({ id: user.id, name: user.name })
                .from(user)
                .where(inArray(user.id, [...userIds])),
            ),
          )
        : [];

    const userMap = new Map(usersResult.map((u) => [u.id, u.name]));

    return Result.ok(
      rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        matterId: row.matterId,
        dateIncurred: row.dateIncurred,
        amount: row.amount,
        currency: row.currency,
        category: row.category,
        description: row.description,
        invoiceDescription: row.invoiceDescription,
        billable: row.billable,
        markup: row.markup,
        status: row.status,
        userName: row.userId ? (userMap.get(row.userId) ?? null) : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt?.toISOString() ?? null,
      })),
    );
  },
);

export default readExpenses;
