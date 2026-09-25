import type { Transaction } from "@/api/db/root";
import { caseLawCourtWeights, caseLawFtsConfigs } from "@/api/db/schema";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

/**
 * The two search-configuration reads, one statement each, and nothing about
 * where they run. The public corpus runs them through the public-law reader
 * (`public-case-law-config.ts`) and the local corpus on the service's own
 * connection (`local-case-law-config.ts`); both run these same statements.
 *
 * Writes live in `case-law-config-store.ts`, so this module holds nothing a
 * reader role cannot run.
 */
export type CaseLawConfigReadTransaction = Pick<Transaction, "select">;

/**
 * The whole registry, unordered on purpose. The court-weight cache puts every
 * list a lookup walks into `compareCourtWeightPrecedence` order, and that
 * order is total — tier, then country, then pattern, over rows unique in
 * `(country, pattern)` — so the rank a court resolves to does not depend on
 * the order these rows arrive in. Ordering here as well would buy nothing and
 * cost a `require-query-limit` suppression for a read that wants every row.
 */
export const readCourtWeightRowsQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCourtWeights,
  async (tx: CaseLawConfigReadTransaction) =>
    await tx
      .select({
        country: caseLawCourtWeights.country,
        courtPattern: caseLawCourtWeights.courtPattern,
        tier: caseLawCourtWeights.tier,
        tierLabel: caseLawCourtWeights.tierLabel,
        weight: caseLawCourtWeights.weight,
      })
      .from(caseLawCourtWeights),
);

export const readFtsConfigRowsQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawFtsConfigs,
  async (tx: CaseLawConfigReadTransaction) =>
    await tx
      .select({
        language: caseLawFtsConfigs.language,
        regconfig: caseLawFtsConfigs.regconfig,
        useUnaccent: caseLawFtsConfigs.useUnaccent,
      })
      .from(caseLawFtsConfigs),
);

export type CourtWeightRow = Awaited<
  ReturnType<typeof readCourtWeightRowsQuery>
>[number];

export type FtsConfigRow = Awaited<
  ReturnType<typeof readFtsConfigRowsQuery>
>[number];
