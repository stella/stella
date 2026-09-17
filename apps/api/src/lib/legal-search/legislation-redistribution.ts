import { inArray, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import { legislationDocuments, legislationSources } from "@/api/db/schema";

// null descriptor = legacy public source, treated as redistributable.
export const redistributableLegislationSource = sql`(
  ${legislationSources.descriptor} IS NULL
  OR (${legislationSources.descriptor} ->> 'allowsRedistribution') = 'true'
)`;

/** Accepts the real country column, including an aliased search projection. */
export const publishedLegislationCountryFor = (country: SQLWrapper) =>
  inArray(country, PUBLIC_LEGISLATION_COUNTRIES);

/** Source permission and jurisdiction admission are both required for public wording. */
export const publishedLegislationDocument = sql`(
  ${redistributableLegislationSource}
  AND ${publishedLegislationCountryFor(legislationDocuments.country)}
)`;

/**
 * The same policy, correlated to `legislation_documents`, for a read that
 * addresses a version by id instead of joining its source. A public read of a
 * version applies one of the two forms; neither carries a policy of its own.
 */
export const redistributableLegislationVersion = sql`EXISTS (
  SELECT 1
    FROM ${legislationSources}
   WHERE ${legislationSources.id} = ${legislationDocuments.sourceId}
     AND ${publishedLegislationDocument}
)`;

/**
 * AI use is a separate permission from displaying source wording, on the
 * joined source row. The same two forms as redistribution above: this one for
 * a read that joins `legislation_sources`, the correlated one below for a
 * read that addresses a version by id.
 */
export const derivedAiLegislationSource = sql<boolean>`(
  ${legislationSources.descriptor} IS NULL
  OR (${legislationSources.descriptor} ->> 'allowsDerivedAi') = 'true'
)`;

export const derivedAiLegislationVersion = sql`EXISTS (
  SELECT 1 FROM ${legislationSources}
   WHERE ${legislationSources.id} = ${legislationDocuments.sourceId}
     AND ${derivedAiLegislationSource}
)`;
