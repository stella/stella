import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { t, type Static } from "elysia";

import { db } from "@/api/db";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const resolveRateQuerySchema = t.Object({
  userId: t.String({ minLength: 1 }),
  date: t.String({ format: "date" }),
});

type ResolveRateQuerySchema = Static<typeof resolveRateQuerySchema>;

type ResolveRateHandlerProps = {
  workspaceId: SafeId<"workspace">;
  query: ResolveRateQuerySchema;
};

export const resolveRateHandler = async ({
  workspaceId,
  query,
}: ResolveRateHandlerProps) => {
  const result = await resolveRate({
    workspaceId,
    userId: query.userId,
    dateWorked: query.date,
  });

  return result ?? { hourlyRate: null, currency: null };
};

export const resolveRate = async ({
  workspaceId,
  userId,
  dateWorked,
}: {
  workspaceId: SafeId<"workspace">;
  userId: string;
  dateWorked: string;
}): Promise<{ hourlyRate: number; currency: string } | null> => {
  const defaultTable = await db.query.rateTables.findFirst({
    where: { workspaceId: { eq: workspaceId }, isDefault: true },
    columns: { id: true, currency: true },
  });

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
  const userRate = await db
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
    .limit(1);

  if (userRate.length > 0) {
    return {
      hourlyRate: userRate[0].hourlyRate,
      currency: defaultTable.currency,
    };
  }

  // Fall back to table default rate (userId IS NULL)
  const defaultRate = await db
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
    .limit(1);

  if (defaultRate.length > 0) {
    return {
      hourlyRate: defaultRate[0].hourlyRate,
      currency: defaultTable.currency,
    };
  }

  return null;
};
