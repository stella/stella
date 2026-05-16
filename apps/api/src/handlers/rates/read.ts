import { Result } from "better-result";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { rateEntries, rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { brandPersistedRateTableId } from "@/api/lib/safe-id-boundaries";

const readRateTablesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

type RateTableCursor = {
  createdAt: Date;
  id: SafeId<"rateTable">;
};

const decodeRateTableCursor = (cursor: string): RateTableCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const createdAt = parts?.at(0);
  const id = parts?.at(1);

  if (typeof createdAt !== "string" || typeof id !== "string") {
    return null;
  }

  const createdAtDate = new Date(createdAt);
  if (Number.isNaN(createdAtDate.getTime())) {
    return null;
  }

  return { createdAt: createdAtDate, id: brandPersistedRateTableId(id) };
};

const readRateTables = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: readRateTablesQuerySchema,
  },
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? 50;
    const conditions = [eq(rateTables.workspaceId, workspaceId)];

    if (query.cursor) {
      const cursor = decodeRateTableCursor(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const cursorCondition = or(
        gt(rateTables.createdAt, cursor.createdAt),
        and(
          eq(rateTables.createdAt, cursor.createdAt),
          gt(rateTables.id, cursor.id),
        ),
      );

      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const tables = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: rateTables.id,
            name: rateTables.name,
            currency: rateTables.currency,
            isDefault: rateTables.isDefault,
            createdAt: rateTables.createdAt,
            updatedAt: rateTables.updatedAt,
          })
          .from(rateTables)
          .where(and(...conditions))
          .orderBy(asc(rateTables.createdAt), asc(rateTables.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows: tables,
      limit,
      cursorForItem: (item) =>
        encodePaginationCursor([item.createdAt.toISOString(), item.id]),
    });

    // Batch count entries per table
    const tableIds = page.items.map((table) => table.id);
    const entryCounts = new Map<string, number>();

    if (tableIds.length > 0) {
      const counts = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              rateTableId: rateEntries.rateTableId,
              count: sql<number>`count(*)::int`.as("count"),
            })
            .from(rateEntries)
            .where(inArray(rateEntries.rateTableId, tableIds))
            .groupBy(rateEntries.rateTableId),
        ),
      );

      for (const row of counts) {
        entryCounts.set(row.rateTableId, row.count);
      }
    }

    return Result.ok({
      ...page,
      items: page.items.map((table) => ({
        id: table.id,
        name: table.name,
        currency: table.currency,
        isDefault: table.isDefault,
        entryCount: entryCounts.get(table.id) ?? 0,
        createdAt: table.createdAt.toISOString(),
        updatedAt: table.updatedAt.toISOString(),
      })),
    });
  },
);

export default readRateTables;
