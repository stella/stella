import { eq, inArray, sql } from "drizzle-orm";
import { t } from "elysia";

import { rateEntries, rateTables } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";

const readRateTablesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
});

const readRateTables = createHandler(
  {
    permissions: { workspace: ["read"] },
    query: readRateTablesQuerySchema,
  },
  async ({ scopedDb, workspaceId, query }) => {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const tables = await scopedDb((tx) =>
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
        .where(eq(rateTables.workspaceId, workspaceId))
        .orderBy(rateTables.createdAt)
        .limit(limit)
        .offset(offset),
    );

    // Batch count entries per table
    const tableIds = tables.map((table) => table.id);
    const entryCounts = new Map<string, number>();

    if (tableIds.length > 0) {
      const counts = await scopedDb((tx) =>
        tx
          .select({
            rateTableId: rateEntries.rateTableId,
            count: sql<number>`count(*)::int`.as("count"),
          })
          .from(rateEntries)
          .where(inArray(rateEntries.rateTableId, tableIds))
          .groupBy(rateEntries.rateTableId),
      );

      for (const row of counts) {
        entryCounts.set(row.rateTableId, row.count);
      }
    }

    return tables.map((table) => ({
      ...table,
      entryCount: entryCounts.get(table.id) ?? 0,
      createdAt: table.createdAt.toISOString(),
      updatedAt: table.updatedAt.toISOString(),
    }));
  },
);

export default readRateTables;
