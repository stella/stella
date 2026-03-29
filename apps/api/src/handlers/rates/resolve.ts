import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { rateEntries } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";

export const resolveRateQuerySchema = t.Object({
  userId: t.String({ minLength: 1 }),
  date: t.String({ format: "date" }),
});

const resolveRateHandler = createHandler(
  {
    permissions: { workspace: ["read"] },
    query: resolveRateQuerySchema,
  },
  async ({ scopedDb, workspaceId, query }) => {
    const result = await resolveRate({
      scopedDb,
      workspaceId,
      userId: query.userId,
      dateWorked: query.date,
    });

    return result ?? { hourlyRate: null, currency: null };
  },
);

export const resolveRate = async ({
  scopedDb,
  workspaceId,
  userId,
  dateWorked,
}: {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  userId: string;
  dateWorked: string;
}): Promise<{ hourlyRate: number; currency: string } | null> => {
  const defaultTable = await scopedDb((tx) =>
    tx.query.rateTables.findFirst({
      where: { workspaceId: { eq: workspaceId }, isDefault: true },
      columns: { id: true, currency: true },
    }),
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
  const userRate = await scopedDb((tx) =>
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
  );

  const userRateRow = userRate.at(0);
  if (userRateRow) {
    return {
      hourlyRate: userRateRow.hourlyRate,
      currency: defaultTable.currency,
    };
  }

  // Fall back to table default rate (userId IS NULL)
  const defaultRate = await scopedDb((tx) =>
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
