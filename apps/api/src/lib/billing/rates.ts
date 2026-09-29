import type { Err } from "better-result";
import { Result } from "better-result";
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type RateLookup = {
  dateWorked: string;
  userId: SafeId<"user">;
};

type ResolvedRate = { hourlyRate: number; currency: string };

export const rateLookupKey = ({ dateWorked, userId }: RateLookup) =>
  `${userId}:${dateWorked}`;

/**
 * Resolve a batch of entries against one consistent rate-table snapshot.
 * Keeping this transaction-aware lets batch mutations lock their target rows,
 * resolve every effective rate, and either snapshot all rates or write none.
 */
export const resolveRatesInTransaction = async ({
  tx,
  workspaceId,
  lookups,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  lookups: readonly RateLookup[];
}) => {
  const resolved = new Map<string, ResolvedRate>();
  if (lookups.length === 0) {
    return resolved;
  }

  const defaultTable = await tx.query.rateTables.findFirst({
    where: { workspaceId: { eq: workspaceId }, isDefault: true },
    columns: { id: true, currency: true },
  });
  if (!defaultTable) {
    return resolved;
  }

  const firstLookup = lookups.at(0);
  if (!firstLookup) {
    return resolved;
  }
  const uniqueUsers = new Set<SafeId<"user">>();
  let earliestDate = firstLookup.dateWorked;
  let latestDate = firstLookup.dateWorked;
  for (const lookup of lookups) {
    uniqueUsers.add(lookup.userId);
    if (lookup.dateWorked < earliestDate) {
      earliestDate = lookup.dateWorked;
    }
    if (lookup.dateWorked > latestDate) {
      latestDate = lookup.dateWorked;
    }
  }
  const entries = await tx
    .select({
      effectiveFrom: rateEntries.effectiveFrom,
      effectiveTo: rateEntries.effectiveTo,
      hourlyRate: rateEntries.hourlyRate,
      userId: rateEntries.userId,
    })
    .from(rateEntries)
    .where(
      and(
        eq(rateEntries.rateTableId, defaultTable.id),
        lte(rateEntries.effectiveFrom, latestDate),
        or(
          isNull(rateEntries.effectiveTo),
          gte(rateEntries.effectiveTo, earliestDate),
        ),
        or(
          isNull(rateEntries.userId),
          inArray(rateEntries.userId, [...uniqueUsers]),
        ),
      ),
    )
    .orderBy(desc(rateEntries.effectiveFrom))
    .limit(LIMITS.rateEntriesPerTable);

  const entriesByUser = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = entry.userId ?? "__default__";
    const bucket = entriesByUser.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      entriesByUser.set(key, [entry]);
    }
  }

  for (const lookup of lookups) {
    const userEntry = entriesByUser
      .get(lookup.userId)
      ?.find(
        (entry) =>
          entry.effectiveFrom <= lookup.dateWorked &&
          (entry.effectiveTo === null ||
            entry.effectiveTo >= lookup.dateWorked),
      );
    const defaultEntry = entriesByUser
      .get("__default__")
      ?.find(
        (entry) =>
          entry.effectiveFrom <= lookup.dateWorked &&
          (entry.effectiveTo === null ||
            entry.effectiveTo >= lookup.dateWorked),
      );
    const entry = userEntry ?? defaultEntry;
    if (entry) {
      resolved.set(rateLookupKey(lookup), {
        hourlyRate: entry.hourlyRate,
        currency: defaultTable.currency,
      });
    }
  }

  return resolved;
};

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
}): AsyncGenerator<Err<never, SafeDbError>, ResolvedRate | null, unknown> {
  const rates = yield* Result.await(
    safeDb(
      async (tx) =>
        await resolveRatesInTransaction({
          lookups: [{ dateWorked, userId }],
          tx,
          workspaceId,
        }),
    ),
  );
  return rates.get(rateLookupKey({ dateWorked, userId })) ?? null;
};
