import { Result } from "better-result";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { rateEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { brandPersistedRateEntryId } from "@/api/lib/safe-id-boundaries";

const readRateEntriesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

const rateEntryParamsSchema = workspaceParams({
  rateTableId: tSafeId("rateTable"),
});

type RateEntryCursor = {
  effectiveFrom: string;
  id: SafeId<"rateEntry">;
};

const dateCursorPattern = /^\d{4}-\d{2}-\d{2}$/u;

const decodeRateEntryCursor = (cursor: string): RateEntryCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const effectiveFrom = parts?.at(0);
  const id = parts?.at(1);

  if (
    typeof effectiveFrom !== "string" ||
    !dateCursorPattern.test(effectiveFrom) ||
    typeof id !== "string"
  ) {
    return null;
  }

  return { effectiveFrom, id: brandPersistedRateEntryId(id) };
};

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
      return Result.ok({
        items: [],
        limit: query.limit ?? 200,
        nextCursor: null,
      });
    }

    const limit = query.limit ?? 200;
    const conditions = [eq(rateEntries.rateTableId, params.rateTableId)];

    if (query.cursor) {
      const cursor = decodeRateEntryCursor(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const cursorCondition = or(
        gt(rateEntries.effectiveFrom, cursor.effectiveFrom),
        and(
          eq(rateEntries.effectiveFrom, cursor.effectiveFrom),
          gt(rateEntries.id, cursor.id),
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
            id: rateEntries.id,
            userId: rateEntries.userId,
            hourlyRate: rateEntries.hourlyRate,
            effectiveFrom: rateEntries.effectiveFrom,
            effectiveTo: rateEntries.effectiveTo,
            createdAt: rateEntries.createdAt,
          })
          .from(rateEntries)
          .where(and(...conditions))
          .orderBy(asc(rateEntries.effectiveFrom), asc(rateEntries.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        encodePaginationCursor([item.effectiveFrom, item.id]),
    });

    const userIds = new Set<string>();
    for (const row of page.items) {
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

    return Result.ok({
      ...page,
      items: page.items.map((row) => ({
        id: row.id,
        userId: row.userId,
        hourlyRate: row.hourlyRate,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        userImage: row.userId ? (userMap.get(row.userId)?.image ?? null) : null,
        userName: row.userId ? (userMap.get(row.userId)?.name ?? null) : null,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  },
);

export default readRateEntries;
