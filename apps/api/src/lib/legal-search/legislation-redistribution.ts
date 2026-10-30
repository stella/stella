import { inArray, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import {
  PUBLIC_LEGISLATION_COUNTRIES,
  PUBLIC_LEGISLATION_PAGE_COUNTRIES,
} from "@stll/api-contract/legislation-publication";
import {
  publicCountriesFor,
  type PublicCountrySurface,
} from "@stll/api-contract/public-country-capability";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { redistributableLegislationSourceFor } from "@/api/lib/legal-search/legislation-redistribution-sql";

// null descriptor = legacy public source, treated as redistributable.
export const redistributableLegislationSource =
  redistributableLegislationSourceFor(legislationSources.descriptor);

/**
 * The countries a surface serves, total over surfaces: a page read answers
 * for pages-public countries, a search read only for search-admitted ones.
 */
const LEGISLATION_COUNTRIES_BY_SURFACE = {
  identity: publicCountriesFor("legislation", "identity"),
  pages: PUBLIC_LEGISLATION_PAGE_COUNTRIES,
  search: PUBLIC_LEGISLATION_COUNTRIES,
} as const satisfies Record<PublicCountrySurface, readonly string[]>;

/** The countries whose legislation the surface serves. */
export const legislationCountriesFor = (
  surface: PublicCountrySurface,
): readonly string[] => LEGISLATION_COUNTRIES_BY_SURFACE[surface];

/**
 * Source permission and admission among the given countries, for a read
 * that carries the country list its caller's surface resolved to.
 */
export const publishedLegislationDocumentIn = (
  countries: readonly string[],
) => sql`(
  ${redistributableLegislationSource}
  AND ${inArray(legislationDocuments.country, [...countries])}
)`;

/** Accepts the real country column, including an aliased search projection. */
export const publishedLegislationCountryFor = (
  country: SQLWrapper,
  surface: PublicCountrySurface,
) => inArray(country, LEGISLATION_COUNTRIES_BY_SURFACE[surface]);

/** Source permission and jurisdiction admission on the named surface are both required for public wording. */
export const publishedLegislationDocumentFor = (
  surface: PublicCountrySurface,
) => sql`(
  ${redistributableLegislationSource}
  AND ${publishedLegislationCountryFor(legislationDocuments.country, surface)}
)`;

/**
 * The same pair for a projection joined to `legislation_sources` that carries
 * its own country column, such as a refreshed per-source count.
 */
export const publishedLegislationProjectionFor = (
  country: SQLWrapper,
  surface: PublicCountrySurface,
) => sql`(
  ${redistributableLegislationSource}
  AND ${publishedLegislationCountryFor(country, surface)}
)`;

/**
 * The same policy, correlated to `legislation_documents`, for a read that
 * addresses a version by id instead of joining its source. A public read of a
 * version applies one of the two forms; neither carries a policy of its own.
 */
export const redistributableLegislationVersionFor = (
  surface: PublicCountrySurface,
) => sql`EXISTS (
  SELECT 1
    FROM ${legislationSources}
   WHERE ${legislationSources.id} = ${legislationDocuments.sourceId}
     AND ${publishedLegislationDocumentFor(surface)}
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
