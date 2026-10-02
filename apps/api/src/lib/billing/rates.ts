import type { Err } from "better-result";
import { panic, Result } from "better-result";
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { rateEntries, rateTables } from "@/api/db/schema";
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
    columns: { id: true, organizationId: true },
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
  // A membership can name several roles in one comma-separated value. The
  // roles it holds are kept in canonical order, which is their precedence for
  // a role rate; a name outside the model selects no role rate, and the
  // member still resolves through person and table-default rates.
  const rolesByUser = new Map(
    memberships.map((membership) => {
      const held = new Set(
        membership.role.split(",").map((role) => role.trim()),
      );
      return [
        membership.userId,
        ORGANIZATION_ROLE_NAMES.filter((role) => held.has(role)),
      ] as const;
    }),
  );
  // A rate is stored in its table's currency's minor units, and a currency
  // change restates every rate. Each statement here sees its own snapshot, so
  // the currency is read in the statement that reads the rates: a change
  // committed between two statements cannot pair one side's code with the
  // other side's amounts.
  const entries = await tx
    .select({
      effectiveFrom: rateEntries.effectiveFrom,
      effectiveTo: rateEntries.effectiveTo,
      hourlyRate: rateEntries.hourlyRate,
      userId: rateEntries.userId,
      role: rateEntries.role,
      currency: rateTables.currency,
    })
    .from(rateEntries)
    .innerJoin(rateTables, eq(rateTables.id, rateEntries.rateTableId))
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
    const roles = rolesByUser.get(lookup.userId);
    if (roles === undefined) {
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
    const roleEntry = roles
      .map((role) =>
        entriesByRole
          .get(role)
          ?.find(
            (entry) =>
              entry.effectiveFrom <= lookup.dateWorked &&
              (entry.effectiveTo === null ||
                entry.effectiveTo >= lookup.dateWorked),
          ),
      )
      .find((entry) => entry !== undefined);
    const defaultEntry = defaultEntries.find(
      (entry) =>
        entry.effectiveFrom <= lookup.dateWorked &&
        (entry.effectiveTo === null || entry.effectiveTo >= lookup.dateWorked),
    );
    const entry = userEntry ?? roleEntry ?? defaultEntry;
    if (entry) {
      resolved.set(rateLookupKey(lookup), {
        hourlyRate: entry.hourlyRate,
        currency: entry.currency,
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
