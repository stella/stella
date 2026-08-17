import { Result, TaggedError } from "better-result";
import { not } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";

export class NonRedistributableSourcesError extends TaggedError(
  "NonRedistributableSourcesError",
)<{
  message: string;
  cause?: unknown;
}> {}

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
export const readNonRedistributableCaseLawSourceIds = async () =>
  await Result.tryPromise({
    try: async () =>
      await caseLawPublicReadDb(async (tx) => {
        const rows = await tx
          .select({ id: caseLawSources.id })
          .from(caseLawSources)
          .where(not(redistributableCaseLawSource));

        return rows.map(({ id }) => id);
      }),
    catch: (cause) =>
      new NonRedistributableSourcesError({
        message:
          cause instanceof Error
            ? cause.message
            : "reading non-redistributable case-law sources failed",
        cause,
      }),
  });
