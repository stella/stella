import { Result, TaggedError } from "better-result";
import { not, sql } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

export class NonRedistributableSourcesError extends TaggedError(
  "NonRedistributableSourcesError",
)<{
  message: string;
  cause?: unknown;
}> {}

const sourceRegistryError = (cause: unknown) =>
  new NonRedistributableSourcesError({
    message:
      cause instanceof Error
        ? cause.message
        : "reading non-redistributable case-law sources failed",
    cause,
  });

/**
 * The sources a public surface may not count or serve, read from the same
 * predicate the SQL surfaces filter with, so the two cannot drift.
 *
 * This exists for surfaces that aggregate the corpus index rather than the
 * table. Projection is a write-time gate: revoking a source's redistribution
 * only queues its documents for removal, so between the flip and the
 * reconciliation the index still holds them. Reading the ineligible set here
 * makes the gate query-time, the way the search path re-applies it when it
 * rehydrates index candidates.
 *
 * The table holds one row per court feed, so this is a few dozen ids at most.
 */
export const readNonRedistributableCaseLawSourceIdsQuery =
  definePublicLawSharedQuery(
    PUBLIC_LAW_SHARED_QUERY.caseLawNonRedistributableSources,
    async (tx: CaseLawPublicReadTransaction) => {
      const rows = await tx
        .select({ id: caseLawSources.id })
        .from(caseLawSources)
        .where(not(redistributableCaseLawSource));

      return rows.map(({ id }) => id);
    },
  );

export const readNonRedistributableCaseLawSourceIds = async () =>
  await Result.tryPromise({
    try: async () =>
      await caseLawPublicReadDb(readNonRedistributableCaseLawSourceIdsQuery),
    catch: (cause) => sourceRegistryError(cause),
  });

export type CaseLawSourceRegistry = {
  /** The ids a public surface may not count or serve. */
  excludedSourceIds: SafeId<"caseLawSource">[];
  /** Display names, for the buckets an aggregation comes back with. */
  nameById: Map<string, string>;
};

/**
 * The registry an aggregating surface needs, in one read.
 *
 * A facet read wants both halves: the ineligible ids it must exclude before
 * counting, and the names it will label whatever buckets come back with. The
 * table holds one row per court feed, so reading it whole once costs less than
 * reading the ids now and the names of the buckets later, on the far side of
 * the aggregation.
 */
const readCaseLawSourceRegistryQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawNonRedistributableSources,
  async (tx: CaseLawPublicReadTransaction): Promise<CaseLawSourceRegistry> => {
    const rows = await tx
      .select({
        id: caseLawSources.id,
        name: caseLawSources.name,
        redistributable: sql<boolean>`${redistributableCaseLawSource}`,
      })
      .from(caseLawSources);

    return {
      excludedSourceIds: rows
        .filter(({ redistributable }) => !redistributable)
        .map(({ id }) => id),
      nameById: new Map(rows.map(({ id, name }) => [String(id), name])),
    };
  },
);

export const readCaseLawSourceRegistry = async () =>
  await Result.tryPromise({
    try: async () => await caseLawPublicReadDb(readCaseLawSourceRegistryQuery),
    catch: (cause) => sourceRegistryError(cause),
  });
