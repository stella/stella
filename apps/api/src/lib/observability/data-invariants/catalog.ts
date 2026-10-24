import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { getCaseLawIngestionDb } from "@/api/lib/case-law-ingestion-db";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  probeExpansionDictionary,
  PUBLISHED_EXPANSION_LANGUAGES,
} from "@/api/lib/legal-search/expansion";
import { isSearchIndexUnavailable } from "@/api/lib/legal-search/search-index-unavailable";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import {
  type CaseLawCanaryAnswer,
  caseLawSearchCanariesInvariant,
} from "@/api/lib/observability/data-invariants/case-law-canary";
import { caseLawIngestionDailyBandInvariant } from "@/api/lib/observability/data-invariants/case-law-ingestion";
import type { CaseLawCanary } from "@/api/lib/observability/data-invariants/config-schema";
import {
  DATA_INVARIANT_ID,
  type DataInvariant,
  type DataInvariantId,
  type DataInvariantReadDb,
} from "@/api/lib/observability/data-invariants/invariant";
import { queryExpansionDictionariesInvariant } from "@/api/lib/observability/data-invariants/query-expansion";
import {
  sanctionsListsInvariant,
  sanctionsScreeningCompletenessInvariant,
} from "@/api/lib/observability/data-invariants/sanctions";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import {
  defaultSearchDecisionsHandler,
  isSearchCaseLawSuccess,
} from "@/api/mcp/public-law-handlers";

/** One page of one hit is enough to tell an answer from an empty one. */
const CANARY_PAGE_SIZE = 1;

/** A canary through the same handler, read role and narrowing MCP uses. */
const searchCaseLawCanary = async ({
  country,
  query,
}: CaseLawCanary): Promise<CaseLawCanaryAnswer> => {
  const publicCountry = publicCaseLawCountry(country);
  if (publicCountry === null) {
    return { type: "unknown-country" };
  }
  const result = await defaultSearchDecisionsHandler({
    body: { query, country: publicCountry, limit: CANARY_PAGE_SIZE },
    caseLawDb: caseLawPublicReadDb,
    observer: "unobserved",
  });
  if (isSearchIndexUnavailable(result)) {
    return { type: "index-unavailable" };
  }
  if (!isSearchCaseLawSuccess(result)) {
    return { type: "refused" };
  }
  return { type: "hits", count: result.hits.length };
};

/**
 * Every invariant this deployment checks, wired to production reads. Keyed by
 * id and total over `DataInvariantId`, so an id cannot be declared without an
 * invariant behind it, nor an invariant filed under another's id.
 */
export const productionDataInvariants = (
  schedulerDb: SchedulerDb,
): readonly DataInvariant[] => {
  // The system connection: aggregates span tenants and return counts only.
  const db: DataInvariantReadDb = async (read) => await read(schedulerDb);
  const catalog = {
    [DATA_INVARIANT_ID.sanctionsListsLoaded]: sanctionsListsInvariant({
      readFreshness: async (now) =>
        await readSanctionsFreshness({ db: getCaseLawIngestionDb(), now }),
    }),
    [DATA_INVARIANT_ID.sanctionsScreeningCompleteness]:
      sanctionsScreeningCompletenessInvariant({ db }),
    [DATA_INVARIANT_ID.caseLawIngestionDailyBand]:
      caseLawIngestionDailyBandInvariant({
        db,
        bands: env.DATA_INVARIANT_CASE_LAW_DAILY_BANDS,
      }),
    [DATA_INVARIANT_ID.caseLawSearchCanaries]: caseLawSearchCanariesInvariant({
      canaries: env.DATA_INVARIANT_CASE_LAW_CANARIES,
      search: searchCaseLawCanary,
    }),
    [DATA_INVARIANT_ID.queryExpansionDictionaries]:
      queryExpansionDictionariesInvariant({
        mode: envBase.QUERY_EXPANSION_MODE,
        languages: PUBLISHED_EXPANSION_LANGUAGES,
        probe: probeExpansionDictionary,
      }),
  } as const satisfies { [Id in DataInvariantId]: DataInvariant<string, Id> };
  return Object.values(catalog);
};
