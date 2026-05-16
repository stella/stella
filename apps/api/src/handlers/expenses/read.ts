import { Result } from "better-result";
import { and, asc, eq, gt, gte, inArray, lte, or } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import {
  expenseCategorySchema,
  timeEntryStatusSchema,
} from "@/api/db/billing-validators";
import { expenses } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { brandPersistedExpenseId } from "@/api/lib/safe-id-boundaries";

const readExpensesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
  cursor: t.Optional(t.String({ maxLength: 512 })),
  userId: t.Optional(tUserId),
  matterId: t.Optional(tSafeId("entity")),
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

type ExpenseCursor = {
  dateIncurred: string;
  id: SafeId<"expense">;
};

const dateCursorPattern = /^\d{4}-\d{2}-\d{2}$/u;

const decodeExpenseCursor = (cursor: string): ExpenseCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const dateIncurred = parts?.at(0);
  const id = parts?.at(1);

  if (
    typeof dateIncurred !== "string" ||
    !dateCursorPattern.test(dateIncurred) ||
    typeof id !== "string"
  ) {
    return null;
  }

  return { dateIncurred, id: brandPersistedExpenseId(id) };
};

const readExpenses = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, query }) {
    const limit = query.limit ?? 100;

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
    if (query.cursor) {
      const cursor = decodeExpenseCursor(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const cursorCondition = or(
        gt(expenses.dateIncurred, cursor.dateIncurred),
        and(
          eq(expenses.dateIncurred, cursor.dateIncurred),
          gt(expenses.id, cursor.id),
        ),
      );

      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
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
          .orderBy(asc(expenses.dateIncurred), asc(expenses.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        encodePaginationCursor([item.dateIncurred, item.id]),
    });

    // Batch-fetch user names
    const userIds = new Set<string>();
    for (const row of page.items) {
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
                .from(member)
                .innerJoin(user, eq(member.userId, user.id))
                .where(
                  and(
                    eq(member.organizationId, session.activeOrganizationId),
                    inArray(member.userId, [...userIds]),
                  ),
                ),
            ),
          )
        : [];

    const userMap = new Map(usersResult.map((u) => [u.id, u.name]));

    return Result.ok({
      ...page,
      items: page.items.map((row) => ({
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
    });
  },
);

export default readExpenses;
