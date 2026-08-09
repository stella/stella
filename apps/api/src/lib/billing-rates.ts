import type { Err } from "better-result";
import { Result } from "better-result";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const resolveRate = async function* ({
  safeDb,
  workspaceId,
  userId,
  dateWorked,
}: {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
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

  const userRate = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({ hourlyRate: rateEntries.hourlyRate })
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

  const defaultRate = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({ hourlyRate: rateEntries.hourlyRate })
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
