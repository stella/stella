import type { Err } from "better-result";
import { Result } from "better-result";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb, SafeDbError } from "@/api/db";
import { rateEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ValidatedOrgUserId } from "@/api/lib/validated-org-user-id";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

const resolveRateQuerySchema = t.Object({
  userId: tUserId,
  date: t.String({ format: "date" }),
});

const resolveRateHandler = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: resolveRateQuerySchema,
  },
  async function* ({ safeDb, workspaceId, session, query }) {
    const userId = query.userId;
    const validatedUserId = yield* Result.await(
      safeDb(
        async (tx) =>
          await validateOrgUserId(tx, userId, session.activeOrganizationId),
      ),
    );

    if (!validatedUserId) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "User is not a member of this organization",
        }),
      );
    }

    const result = yield* resolveRate({
      safeDb,
      workspaceId,
      userId: validatedUserId,
      dateWorked: query.date,
    });

    return Result.ok(result ?? { hourlyRate: null, currency: null });
  },
);

const resolveRate = async function* ({
  safeDb,
  workspaceId,
  userId,
  dateWorked,
}: {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: ValidatedOrgUserId;
  dateWorked: string;
}): AsyncGenerator<
  Err<never, SafeDbError>,
  { hourlyRate: number; currency: string } | null,
  unknown
> {
  const defaultTable = yield* Result.await(
    safeDb((tx) =>
      tx.query.rateTables.findFirst({
        where: { workspaceId: { eq: workspaceId }, isDefault: true },
        columns: { id: true, currency: true },
      }),
    ),
  );

  if (!defaultTable) {
    return null;
  }

  const dateCondition = and(
    lte(rateEntries.effectiveFrom, dateWorked),
    or(
      isNull(rateEntries.effectiveTo),
      gte(rateEntries.effectiveTo, dateWorked),
    ),
  );

  // Try user-specific rate first
  const userRate = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          hourlyRate: rateEntries.hourlyRate,
        })
        .from(rateEntries)
        .where(
          and(
            eq(rateEntries.rateTableId, defaultTable.id),
            eq(rateEntries.userId, userId),
            dateCondition,
          ),
        )
        .orderBy(desc(rateEntries.effectiveFrom))
        .limit(1),
    ),
  );

  const userRateRow = userRate.at(0);
  if (userRateRow) {
    return {
      hourlyRate: userRateRow.hourlyRate,
      currency: defaultTable.currency,
    };
  }

  // Fall back to table default rate (userId IS NULL)
  const defaultRate = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          hourlyRate: rateEntries.hourlyRate,
        })
        .from(rateEntries)
        .where(
          and(
            eq(rateEntries.rateTableId, defaultTable.id),
            isNull(rateEntries.userId),
            dateCondition,
          ),
        )
        .orderBy(desc(rateEntries.effectiveFrom))
        .limit(1),
    ),
  );

  const defaultRateRow = defaultRate.at(0);
  if (defaultRateRow) {
    return {
      hourlyRate: defaultRateRow.hourlyRate,
      currency: defaultTable.currency,
    };
  }

  return null;
};

export default resolveRateHandler;
