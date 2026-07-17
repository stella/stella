import { Result } from "better-result";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { rateEntries, rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedRateTableId } from "@/api/lib/safe-id-boundaries";

const readRateTablesQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.rateTablesPageSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

const rateTableCursor = createTimestampIdCursorCodec({
  column: rateTables.createdAt,
  brandId: brandPersistedRateTableId,
});

const readRateTables = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "capability", reason: "billing_admin" },
    query: readRateTablesQuerySchema,
  },
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? LIMITS.rateTablesPageSizeDefault;
    const conditions = [eq(rateTables.workspaceId, workspaceId)];

    if (query.cursor) {
      const cursor = rateTableCursor.decode(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const boundary = rateTableCursor.boundary(cursor);
      const cursorCondition = or(
        gt(rateTables.createdAt, boundary),
        and(eq(rateTables.createdAt, boundary), gt(rateTables.id, cursor.id)),
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
            createdAtCursor:
              rateTableCursor.cursorValue.as("created_at_cursor"),
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
        rateTableCursor.encode(item.createdAtCursor, item.id),
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
