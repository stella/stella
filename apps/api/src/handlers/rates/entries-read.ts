import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { rateEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";

const readRateEntriesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
});

const rateEntryParamsSchema = workspaceParams({
  rateTableId: tSafeId("rateTable"),
});

const readRateEntries = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    params: rateEntryParamsSchema,
    query: readRateEntriesQuerySchema,
  },
  async function* ({ safeDb, workspaceId, session, params, query }) {
    const table = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: {
            id: { eq: params.rateTableId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!table) {
      return Result.ok([]);
    }

    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;

    const rows = yield* Result.await(
      safeDb((tx) =>
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
      ),
    );

    const userIds = new Set<string>();
    for (const row of rows) {
      if (row.userId) {
        userIds.add(row.userId);
      }
    }

    const usersResult =
      userIds.size > 0
        ? yield* Result.await(
            safeDb((tx) => {
              const organizationMembers = tx
                .select({ userId: member.userId })
                .from(member)
                .where(
                  and(
                    inArray(member.userId, [...userIds]),
                    eq(member.organizationId, session.activeOrganizationId),
                  ),
                )
                .groupBy(member.userId)
                .as("organization_members");

              return tx
                .select({ id: user.id, image: user.image, name: user.name })
                .from(organizationMembers)
                .innerJoin(user, eq(organizationMembers.userId, user.id));
            }),
          )
        : [];

    const userMap = new Map(
      usersResult.map((u) => [u.id, { image: u.image, name: u.name }]),
    );

    return Result.ok(
      rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        hourlyRate: row.hourlyRate,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        userImage: row.userId ? (userMap.get(row.userId)?.image ?? null) : null,
        userName: row.userId ? (userMap.get(row.userId)?.name ?? null) : null,
        createdAt: row.createdAt.toISOString(),
      })),
    );
  },
);

export default readRateEntries;
