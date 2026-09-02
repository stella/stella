import { Result, TaggedError } from "better-result";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { isCurrentVersionOfWork } from "@/api/handlers/legislation/list";
import { readNonRedistributableLegislationSourceIds } from "@/api/handlers/legislation/non-redistributable-sources";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import {
  inForceToday,
  versionSortKey,
} from "@/api/handlers/legislation/validity-window";
import { errorTag } from "@/api/lib/errors/utils";
import { createTtlResultCache } from "@/api/lib/legal-search/browse-facets-cache";
import { isCorpusIndexJurisdiction } from "@/api/lib/legal-search/index-naming";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/**
 * The law home's legislation shelf: what came into force in the last thirty
 * days and what comes into force in the next thirty, over the one signal the
 * corpus carries for every source, the consolidation window's opening date.
 * Whole-corpus and slow-moving, so it is cached like the decision shelf.
 */

export const legislationShelfQuerySchema = t.Object({
  country: t.String({ minLength: 2, maxLength: 3 }),
});

type LegislationShelfQuery = Static<typeof legislationShelfQuerySchema>;

export type LegislationShelfItem = {
  id: string;
  eli: string;
  title: string;
  country: string;
  language: string;
  documentType: string | null;
  status: string;
  versionValidFrom: string | null;
};

export type LegislationShelf = {
  country: string;
  /** Current consolidations whose window opened within the past window. */
  recentlyInForce: LegislationShelfItem[];
  /** The next consolidation of each work opening within the coming window. */
  enteringIntoForce: LegislationShelfItem[];
};

class LegislationShelfError extends TaggedError("LegislationShelfError")<{
  message: string;
  cause?: unknown;
}> {}

const SHELF_CACHE_TTL_MS = 5 * 60 * 1000;
const SHELF_CACHE_MAX_ENTRIES = 16;

const windowDays = sql.raw(String(LIMITS.legislationShelfWindowDays));

/**
 * Every comparison and ordering on the window's opening goes through the
 * listing's sort key, which is what
 * `legislation_documents_country_valid_from_id_idx` indexes: a raw column
 * comparison would not match the index expression and the shelf would scan
 * the jurisdiction instead of stopping after its few rows.
 */
const validFromKey = versionSortKey(legislationDocuments.versionValidFrom);

const shelfColumns = {
  id: legislationDocuments.id,
  eli: legislationDocuments.eli,
  title: legislationDocuments.title,
  country: legislationDocuments.country,
  language: legislationDocuments.language,
  documentType: legislationDocuments.documentType,
  status: legislationDocuments.status,
  versionValidFrom: legislationDocuments.versionValidFrom,
};

/**
 * The earliest window of a work that has not opened yet: no other future
 * window of the same `(source, eli, language)` opens before this one.
 */
const isNextVersionOfWork = sql`NOT EXISTS (
  SELECT 1
  FROM legislation_documents AS earlier
  WHERE earlier.source_id = ${legislationDocuments.sourceId}
    AND earlier.eli = ${legislationDocuments.eli}
    AND earlier.language = ${legislationDocuments.language}
    AND earlier.id <> ${legislationDocuments.id}
    AND ${versionSortKey(sql`earlier.version_valid_from`)} > CURRENT_DATE
    AND (${versionSortKey(sql`earlier.version_valid_from`)}, earlier.id)
      < (${validFromKey}, ${legislationDocuments.id})
)`;

type ReadLegislationShelfOptions = {
  legislationDb: LegislationReadDb;
  country: string;
};

export const readLegislationShelf = async ({
  legislationDb,
  country,
}: ReadLegislationShelfOptions): Promise<LegislationShelf> =>
  await legislationDb(async (tx) => {
    const recentlyInForce = await tx
      .select(shelfColumns)
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          redistributableLegislationSource,
          eq(legislationDocuments.country, country),
          inForceToday(
            legislationDocuments.versionValidFrom,
            legislationDocuments.versionValidTo,
          ),
          isCurrentVersionOfWork,
          sql`${validFromKey} >= CURRENT_DATE - ${windowDays}`,
        ),
      )
      .orderBy(desc(validFromKey), desc(legislationDocuments.id))
      .limit(LIMITS.legislationShelfPerList);

    const enteringIntoForce = await tx
      .select(shelfColumns)
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          redistributableLegislationSource,
          eq(legislationDocuments.country, country),
          sql`${validFromKey} > CURRENT_DATE`,
          sql`${validFromKey} <= CURRENT_DATE + ${windowDays}`,
          isNextVersionOfWork,
        ),
      )
      .orderBy(asc(validFromKey), asc(legislationDocuments.id))
      .limit(LIMITS.legislationShelfPerList);

    return { country, recentlyInForce, enteringIntoForce };
  });

type LegislationShelfLoad = {
  legislationDb: LegislationReadDb;
  country: string;
  excludedSourceIds: readonly string[];
};

const loadLegislationShelf = async ({
  legislationDb,
  country,
}: LegislationShelfLoad): Promise<
  Result<LegislationShelf, LegislationShelfError>
> =>
  await Result.tryPromise({
    try: async () => await readLegislationShelf({ legislationDb, country }),
    catch: (cause) =>
      new LegislationShelfError({
        message: "Legislation shelf could not be read",
        cause,
      }),
  });

const legislationShelf = createTtlResultCache({
  load: loadLegislationShelf,
  // Source policy is an input to the answer, so a revocation changes the key
  // instead of waiting out the window; sorted because the set has no order.
  key: ({ country, excludedSourceIds }: LegislationShelfLoad) =>
    `${country}:${excludedSourceIds.toSorted().join(",")}`,
  ttlMs: SHELF_CACHE_TTL_MS,
  maxEntries: SHELF_CACHE_MAX_ENTRIES,
});

export const readLegislationShelfHandler = async (
  { country }: LegislationShelfQuery,
  legislationDb: LegislationReadDb,
) => {
  if (!isCorpusIndexJurisdiction(country)) {
    return status(400, { message: "Invalid country" });
  }
  const jurisdiction = country.toUpperCase();
  const empty: LegislationShelf = {
    country: jurisdiction,
    recentlyInForce: [],
    enteringIntoForce: [],
  };

  const excludedSourceIds = await readNonRedistributableLegislationSourceIds();
  if (Result.isError(excludedSourceIds)) {
    logger.warn("legislation.shelf.unavailable", {
      "error.type": errorTag(excludedSourceIds.error),
    });
    return empty;
  }

  const result = await legislationShelf({
    legislationDb,
    country: jurisdiction,
    excludedSourceIds: excludedSourceIds.value,
  });
  if (Result.isError(result)) {
    // The shelf is the home's empty state, not its content: the box still
    // resolves and searches without it, so degrade rather than fail.
    logger.warn("legislation.shelf.unavailable", {
      "error.type": errorTag(result.error),
    });
    return empty;
  }
  return result.value;
};
