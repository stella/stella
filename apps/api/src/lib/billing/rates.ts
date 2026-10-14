import type { Err } from "better-result";
import { panic, Result } from "better-result";
import { and, desc, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type RateLookup = {
  dateWorked: string;
  userId: SafeId<"user">;
};

export type ResolvedRate = { hourlyRate: number; currency: string };

export const rateLookupKey = ({ dateWorked, userId }: RateLookup) =>
  `${userId}:${dateWorked}`;

type WorkspaceRateLookup = RateLookup & { workspaceId: SafeId<"workspace"> };

export const workspaceRateLookupKey = ({
  workspaceId,
  ...lookup
}: WorkspaceRateLookup) => `${workspaceId}:${rateLookupKey(lookup)}`;

/** Resolves authorized matters against one transaction's rate-table snapshot. */
export const resolveWorkspaceRatesInTransaction = async ({
  tx,
  lookups,
}: {
  tx: Transaction;
  lookups: readonly WorkspaceRateLookup[];
}) => {
  const resolved = new Map<string, ResolvedRate>();
  if (lookups.length === 0) {
    return resolved;
  }
  const workspaceIds = [
    ...new Set(lookups.map((lookup) => lookup.workspaceId)),
  ];
  const defaultTables = await tx.query.rateTables.findMany({
    where: { workspaceId: { in: workspaceIds }, isDefault: true },
    columns: {
      id: true,
      workspaceId: true,
      currency: true,
      organizationId: true,
    },
    limit: workspaceIds.length,
  });
  if (defaultTables.length === 0) {
    return resolved;
  }
  const tablesByWorkspace = new Map(
    defaultTables.map((table) => [table.workspaceId, table]),
  );
  const organizationIds = [
    ...new Set(defaultTables.map((table) => table.organizationId)),
  ];
  const firstLookup = lookups.at(0) ?? panic("Missing rate lookup");
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
    .select({
      organizationId: member.organizationId,
      userId: member.userId,
      role: member.role,
    })
    .from(member)
    .where(
      and(
        inArray(member.organizationId, organizationIds),
        inArray(member.userId, [...uniqueUsers]),
      ),
    )
    .limit(uniqueUsers.size * organizationIds.length);
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
        `${membership.organizationId}:${membership.userId}`,
        ORGANIZATION_ROLE_NAMES.filter((role) => held.has(role)),
      ] as const;
    }),
  );
  const entries = await tx
    .select({
      rateTableId: rateEntries.rateTableId,
      effectiveFrom: rateEntries.effectiveFrom,
      effectiveTo: rateEntries.effectiveTo,
      hourlyRate: rateEntries.hourlyRate,
      userId: rateEntries.userId,
      role: rateEntries.role,
    })
    .from(rateEntries)
    .where(
      and(
        inArray(rateEntries.workspaceId, workspaceIds),
        inArray(
          rateEntries.rateTableId,
          defaultTables.map(({ id }) => id),
        ),
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
    .limit(LIMITS.rateEntriesPerTable * defaultTables.length);

  const entriesByUser = new Map<string, typeof entries>();
  const entriesByRole = new Map<string, typeof entries>();
  const defaultEntries = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (entry.userId === null && entry.role === null) {
      const bucket = defaultEntries.get(entry.rateTableId);
      if (bucket) {
        bucket.push(entry);
      } else {
        defaultEntries.set(entry.rateTableId, [entry]);
      }
      continue;
    }
    const buckets = entry.userId === null ? entriesByRole : entriesByUser;
    const selector = entry.userId ?? entry.role;
    if (selector === null) {
      panic("Rate entry has no selector");
    }
    const key = `${entry.rateTableId}:${selector}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      buckets.set(key, [entry]);
    }
  }

  for (const lookup of lookups) {
    const defaultTable = tablesByWorkspace.get(lookup.workspaceId);
    if (!defaultTable) {
      continue;
    }
    const roles = rolesByUser.get(
      `${defaultTable.organizationId}:${lookup.userId}`,
    );
    if (roles === undefined) {
      continue;
    }
    const userEntry = entriesByUser
      .get(`${defaultTable.id}:${lookup.userId}`)
      ?.find(
        (entry) =>
          entry.effectiveFrom <= lookup.dateWorked &&
          (entry.effectiveTo === null ||
            entry.effectiveTo >= lookup.dateWorked),
      );
    const roleEntry = roles
      .map((role) =>
        entriesByRole
          .get(`${defaultTable.id}:${role}`)
          ?.find(
            (entry) =>
              entry.effectiveFrom <= lookup.dateWorked &&
              (entry.effectiveTo === null ||
                entry.effectiveTo >= lookup.dateWorked),
          ),
      )
      .find((entry) => entry !== undefined);
    const defaultEntry = defaultEntries
      .get(defaultTable.id)
      ?.find(
        (entry) =>
          entry.effectiveFrom <= lookup.dateWorked &&
          (entry.effectiveTo === null ||
            entry.effectiveTo >= lookup.dateWorked),
      );
    const entry = userEntry ?? roleEntry ?? defaultEntry;
    if (entry) {
      resolved.set(workspaceRateLookupKey(lookup), {
        hourlyRate: entry.hourlyRate,
        currency: defaultTable.currency,
      });
    }
  }

  return resolved;
};

/** Single-matter callers share the bulk resolver and retain their lookup keys. */
export const resolveRatesInTransaction = async ({
  tx,
  workspaceId,
  lookups,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  lookups: readonly RateLookup[];
}) => {
  const rates = await resolveWorkspaceRatesInTransaction({
    tx,
    lookups: lookups.map((lookup) => ({ ...lookup, workspaceId })),
  });
  const resolved = new Map<string, ResolvedRate>();
  for (const lookup of lookups) {
    const rate = rates.get(workspaceRateLookupKey({ ...lookup, workspaceId }));
    if (rate) {
      resolved.set(rateLookupKey(lookup), rate);
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
