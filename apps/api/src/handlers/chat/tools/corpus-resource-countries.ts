import { inArray } from "drizzle-orm";
import * as v from "valibot";

import { caseLawDecisions, legislationDocuments } from "@/api/db/schema";
import type { CorpusResourceCountryResolver } from "@/api/handlers/chat/tools/corpus-scope";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

const uuidSchema = v.pipe(v.string(), v.uuid());

/**
 * The stored country of the public resources a scoped keyed read names: one
 * indexed select per read, on the same public read boundary the read itself
 * uses. A decision id that is not a UUID cannot exist, so it is left out (and
 * so refused) rather than sent to a uuid column.
 */
export const corpusResourceCountries: CorpusResourceCountryResolver = {
  decisions: async (ids) => {
    const known = ids.filter((id) => v.is(uuidSchema, id));
    if (known.length === 0) {
      return new Map();
    }
    const rows = await caseLawPublicReadDb(
      async (tx) =>
        await tx
          .select({
            id: caseLawDecisions.id,
            country: caseLawDecisions.country,
          })
          .from(caseLawDecisions)
          .where(
            inArray(
              caseLawDecisions.id,
              known.map(brandPersistedCaseLawDecisionId),
            ),
          ),
    );
    return new Map(rows.map(({ id, country }) => [String(id), country]));
  },
  // The same exact ELI match the statute read resolves a work by; every
  // consolidation of a work shares its ELI and its country.
  statutes: async (elis) => {
    if (elis.length === 0) {
      return new Map();
    }
    const rows = await legislationPublicReadDb(
      async (tx) =>
        await tx
          .select({
            eli: legislationDocuments.eli,
            country: legislationDocuments.country,
          })
          .from(legislationDocuments)
          .where(inArray(legislationDocuments.eli, [...elis]))
          .groupBy(legislationDocuments.eli, legislationDocuments.country),
    );
    return new Map(rows.map(({ eli, country }) => [eli, country]));
  },
};
