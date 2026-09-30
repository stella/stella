import type { Err } from "better-result";
import { panic, Result } from "better-result";
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { isMemberRole } from "@/api/lib/member-roles";

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
    columns: { id: true, currency: true, organizationId: true },
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
  const memberships = await tx
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, defaultTable.organizationId),
        inArray(member.userId, [...uniqueUsers]),
      ),
    );
  const rolesByUser = new Map(
    memberships.map((membership) => {
      if (!isMemberRole(membership.role)) {
        panic("Unknown organization member role while resolving rates");
      }
      return [membership.userId, membership.role] as const;
    }),
  );
  const entries = await tx
    .select({
      effectiveFrom: rateEntries.effectiveFrom,
      effectiveTo: rateEntries.effectiveTo,
      hourlyRate: rateEntries.hourlyRate,
      userId: rateEntries.userId,
      role: rateEntries.role,
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
    .orderBy(desc(rateEntries.effectiveFrom), desc(rateEntries.id))
    .limit(LIMITS.rateEntriesPerTable);

  const entriesByUser = new Map<string, typeof entries>();
  const entriesByRole = new Map<string, typeof entries>();
  const defaultEntries: typeof entries = [];
  for (const entry of entries) {
    if (entry.userId === null && entry.role === null) {
      defaultEntries.push(entry);
      continue;
    }
    const buckets = entry.userId === null ? entriesByRole : entriesByUser;
    const key = entry.userId ?? entry.role;
    if (key === null) {
      panic("Rate entry has no selector");
    }
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      buckets.set(key, [entry]);
    }
  }

  for (const lookup of lookups) {
    const role = rolesByUser.get(lookup.userId);
    if (role === undefined) {
      continue;
    }
    const userEntry = entriesByUser
      .get(lookup.userId)
      ?.find(
        (entry) =>
          entry.effectiveFrom <= lookup.dateWorked &&
          (entry.effectiveTo === null ||
            entry.effectiveTo >= lookup.dateWorked),
      );
    const roleEntry = entriesByRole
      .get(role)
      ?.find(
        (entry) =>
          entry.effectiveFrom <= lookup.dateWorked &&
          (entry.effectiveTo === null ||
            entry.effectiveTo >= lookup.dateWorked),
      );
    const defaultEntry = defaultEntries.find(
      (entry) =>
        entry.effectiveFrom <= lookup.dateWorked &&
        (entry.effectiveTo === null || entry.effectiveTo >= lookup.dateWorked),
    );
    const entry = userEntry ?? roleEntry ?? defaultEntry;
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
