import { eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { user } from "@/api/db/auth-schema";
import { rateEntries } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const readRateEntriesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
});

const rateEntryParamsSchema = t.Object({
  rateTableId: tNanoid,
});

const readRateEntries = createHandler(
  {
    permissions: { workspace: ["read"] },
    params: rateEntryParamsSchema,
    query: readRateEntriesQuerySchema,
  },
  async ({ scopedDb, workspaceId, params, query }) => {
    const table = await scopedDb((tx) =>
      tx.query.rateTables.findFirst({
        where: { id: params.rateTableId, workspaceId: { eq: workspaceId } },
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
        .where(eq(rateEntries.rateTableId, params.rateTableId))
        .orderBy(rateEntries.effectiveFrom)
        .limit(limit)
        .offset(offset),
    );

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
              .select({ id: user.id, image: user.image, name: user.name })
              .from(user)
              .where(inArray(user.id, [...userIds])),
          )
        : [];

    const userMap = new Map(
      usersResult.map((u) => [u.id, { image: u.image, name: u.name }]),
    );

    return rows.map((row) => ({
      ...row,
      userImage: row.userId ? (userMap.get(row.userId)?.image ?? null) : null,
      userName: row.userId ? (userMap.get(row.userId)?.name ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    }));
  },
);

export default readRateEntries;
