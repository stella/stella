import { eq, inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const readRateEntriesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
});

type ReadRateEntriesQuerySchema = Static<typeof readRateEntriesQuerySchema>;

type ReadRateEntriesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  rateTableId: string;
  query: ReadRateEntriesQuerySchema;
};

export const readRateEntriesHandler = async ({
  scopedDb,
  workspaceId,
  rateTableId,
  query,
}: ReadRateEntriesHandlerProps) => {
  // Verify table belongs to workspace
  const table = await scopedDb((tx) =>
    tx.query.rateTables.findFirst({
      where: { id: rateTableId, workspaceId: { eq: workspaceId } },
      columns: { id: true },
    }),
  );

  if (!table) {
    return [];
  }

  const limit = query.limit ?? 200;
  const offset = query.offset ?? 0;

  const rows = await scopedDb((tx) =>
    tx
      .select({
        id: rateEntries.id,
        userId: rateEntries.userId,
        hourlyRate: rateEntries.hourlyRate,
        effectiveFrom: rateEntries.effectiveFrom,
        effectiveTo: rateEntries.effectiveTo,
        createdAt: rateEntries.createdAt,
      })
      .from(rateEntries)
      .where(eq(rateEntries.rateTableId, rateTableId))
      .orderBy(rateEntries.effectiveFrom)
      .limit(limit)
      .offset(offset),
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
      ? await scopedDb((tx) =>
          tx
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(inArray(user.id, [...userIds])),
        )
      : [];

  const userMap = new Map(usersResult.map((u) => [u.id, u.name]));

  return rows.map((row) => ({
    ...row,
    userName: row.userId ? (userMap.get(row.userId) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
  }));
};
