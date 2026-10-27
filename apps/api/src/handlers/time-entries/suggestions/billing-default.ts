import { Result } from "better-result";
import { inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { billingArrangements } from "@/api/db/schema";
import {
  type ResolvedRate,
  resolveWorkspaceRatesInTransaction,
  workspaceRateLookupKey,
} from "@/api/lib/billing/rates";
import type { SafeId } from "@/api/lib/branded-types";

type SuggestionBillingLookup = {
  workspaceId: SafeId<"workspace">;
  dateWorked: string;
};

type SuggestionBillingDefault = {
  billable: boolean;
  rate: ResolvedRate | null;
};

export const suggestionBillingLookupKey = ({
  workspaceId,
  dateWorked,
}: SuggestionBillingLookup) => `${workspaceId}:${dateWorked}`;

/**
 * Whether accepted activity bills by default in each matter and day: it does
 * when the timekeeper has a rate there or the matter has a billing
 * arrangement. Every lookup shares one transaction and a fixed set of
 * statements, however many matters and days it covers.
 * @yields The scoped read's failure.
 */
export const resolveSuggestionBillingDefaults = async function* ({
  safeDb,
  userId,
  lookups,
}: {
  safeDb: SafeDb;
  userId: SafeId<"user">;
  lookups: readonly SuggestionBillingLookup[];
}) {
  const resolved = new Map<string, SuggestionBillingDefault>();
  if (lookups.length === 0) {
    return resolved;
  }
  const workspaceIds = [...new Set(lookups.map((item) => item.workspaceId))];
  const { rates, arrangements } = yield* Result.await(
    safeDb(async (tx) => ({
      rates: await resolveWorkspaceRatesInTransaction({
        tx,
        lookups: lookups.map((lookup) => ({ ...lookup, userId })),
      }),
      arrangements: await tx
        .select({
          workspaceId: billingArrangements.workspaceId,
          currency: billingArrangements.currency,
        })
        .from(billingArrangements)
        .where(inArray(billingArrangements.workspaceId, workspaceIds))
        .limit(workspaceIds.length),
    })),
  );
  const currencyByWorkspace = new Map(
    arrangements.map((row) => [row.workspaceId, row.currency]),
  );
  for (const lookup of lookups) {
    const rate =
      rates.get(workspaceRateLookupKey({ ...lookup, userId })) ?? null;
    const currency = currencyByWorkspace.get(lookup.workspaceId);
    resolved.set(suggestionBillingLookupKey(lookup), {
      billable: rate !== null || currency !== undefined,
      rate:
        rate ?? (currency === undefined ? null : { hourlyRate: 0, currency }),
    });
  }
  return resolved;
};

/**
 * The one-matter, one-day form of {@link resolveSuggestionBillingDefaults}.
 * @yields The scoped read's failure.
 */
export const resolveSuggestionBillingDefault = async function* ({
  safeDb,
  workspaceId,
  userId,
  dateWorked,
}: {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  dateWorked: string;
}) {
  const lookup = { workspaceId, dateWorked };
  const defaults = yield* resolveSuggestionBillingDefaults({
    safeDb,
    userId,
    lookups: [lookup],
  });
  const resolved: SuggestionBillingDefault = defaults.get(
    suggestionBillingLookupKey(lookup),
  ) ?? { billable: false, rate: null };
  return resolved;
};
