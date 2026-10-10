import { Result } from "better-result";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { rateEntries } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tPaginationCursor,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedRateEntryId } from "@/api/lib/safe-id-boundaries";

const readRateEntriesQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.rateEntriesPageSizeMax }),
  ),
  cursor: t.Optional(tPaginationCursor()),
});

const rateEntryParamsSchema = workspaceParams({
  rateTableId: tSafeId("rateTable"),
});

type RateEntryCursor = {
  effectiveFrom: string;
  id: SafeId<"rateEntry">;
};

const decodeRateEntryCursor = (cursor: string): RateEntryCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const effectiveFrom = parts?.at(0);
  const id = parts?.at(1);

  if (
    !isDateOnlyPaginationCursorPart(effectiveFrom) ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }

  return { effectiveFrom, id: brandPersistedRateEntryId(id) };
};

const readRateEntries = createSafeHandler(
  {
    description:
      "List the rate lines of one rate table, earliest effective-from first, " +
      "with cursor pagination. Each line carries the hourly rate in minor " +
      "currency units, its effective dates, and its person or organization role selector " +
      "(both null for the table fallback). A rate table that does not exist in " +
      "this matter returns an empty page rather than an error.",
    permissions: { rate: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      readClass: "tenant",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "read",
    params: rateEntryParamsSchema,
    query: readRateEntriesQuerySchema,
  },
  async function* ({ safeDb, workspaceId, session, params, query }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.rateEntriesPageSizeDefault,
    );
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
        limit,
        nextCursor: null,
      });
    }

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
            role: rateEntries.role,
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
        role: row.role,
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
