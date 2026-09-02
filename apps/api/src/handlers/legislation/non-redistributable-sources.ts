import { Result, TaggedError } from "better-result";
import { not } from "drizzle-orm";

import { legislationSources } from "@/api/db/schema";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

export class NonRedistributableLegislationSourcesError extends TaggedError(
  "NonRedistributableLegislationSourcesError",
)<{
  message: string;
  cause?: unknown;
}> {}

/**
 * The legislation sources a public surface may not serve, read from the same
 * predicate the SQL surfaces filter with. A cached surface keys on this set so
 * a revocation changes the key instead of waiting out the cache window. The
 * table holds one row per publisher feed, so this is a handful of ids.
 */
export const readNonRedistributableLegislationSourceIdsQuery =
  definePublicLawSharedQuery(
    PUBLIC_LAW_SHARED_QUERY.legislationNonRedistributableSources,
    async (tx: LegislationReadTransaction) => {
      const rows = await tx
        .select({ id: legislationSources.id })
        .from(legislationSources)
        .where(not(redistributableLegislationSource));

      return rows.map(({ id }) => id);
    },
  );

export const readNonRedistributableLegislationSourceIds = async () =>
  await Result.tryPromise({
    try: async () =>
      await legislationPublicReadDb(
        readNonRedistributableLegislationSourceIdsQuery,
      ),
    catch: (cause) =>
      new NonRedistributableLegislationSourcesError({
        message:
          cause instanceof Error
            ? cause.message
            : "reading non-redistributable legislation sources failed",
        cause,
      }),
  });
