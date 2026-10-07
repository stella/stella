import type { TSchema } from "@sinclair/typebox";
import { t } from "elysia";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { DECISION_PRIMARY_REFERENCE_TYPES } from "@stll/legal-ast/decision-identifier";

import type {
  summarizeDecisionCitationsHandler,
  listLeadingCitationsHandler,
  DecisionCitationRow,
  LeadingCitationRow,
} from "@/api/handlers/case-law/decisions/citation-graph";
import {
  CITATION_TIMELINE_MAX_YEARS,
  LEADING_CITATIONS_PER_TREATMENT,
} from "@/api/handlers/case-law/decisions/citation-graph";
import type { readCaseLawCoverageHandler } from "@/api/handlers/case-law/decisions/coverage";
import {
  CASE_LAW_COVERAGE_HEALTH,
  CASE_LAW_TOTAL_REPORTER,
} from "@/api/handlers/case-law/decisions/coverage-health";
import type { listDecisionFacetsHandler } from "@/api/handlers/case-law/decisions/facets";
import type {
  listLatestDecisionsHandler,
  LatestDecision,
  LatestDecisionsByCourt,
} from "@/api/handlers/case-law/decisions/latest";
import type { listDecisionsHandler } from "@/api/handlers/case-law/decisions/list";
import { languageAlternatesSchema } from "@/api/handlers/case-law/decisions/search-schema";
import { SHELF_TIER_LABEL_VALUES } from "@/api/handlers/case-law/decisions/shelf-courts";
import type {
  listSitemapShardDecisionsHandler,
  listSitemapShardsHandler,
} from "@/api/handlers/case-law/decisions/sitemap";
import type { readCaseLawCorpusStatusHandler } from "@/api/handlers/case-law/decisions/status";
import { CITATION_TREATMENTS } from "@/api/lib/case-law/citation-vocabulary";
import { decisionHeadnotePreviewSchema } from "@/api/lib/case-law/decision-headnote-schema";
import { tSafeId } from "@/api/lib/custom-schema";
import { CASE_LAW_SOURCE_ROWS_BOUND } from "@/api/lib/legal-search/ingestion-constants";
import { LIMITS } from "@/api/lib/limits";
import {
  boundedString,
  nullableBoundedString,
} from "@/api/lib/search/response-text-bounds";
import type { FacetBucket } from "@/api/lib/search/types";

type Success<T extends (...args: never[]) => unknown> = Exclude<
  Awaited<ReturnType<T>>,
  { code: unknown; response: unknown } | { message: string }
>;

// Display caps cover the stored identity columns at four bytes per code point.
const identity = {
  id: tSafeId("caseLawDecision"),
  caseNumber: boundedString(1024),
  slug: nullableBoundedString(1024),
  country: boundedString(12),
  court: boundedString(2048),
  language: boundedString(32),
};
const date = nullableBoundedString(128);
const numberOrNull = t.Union([t.Number(), t.Null()]);
const headnote = decisionHeadnotePreviewSchema;
const decision = {
  ...identity,
  ecli: nullableBoundedString(1024),
  languageAlternates: languageAlternatesSchema,
  decisionDate: date,
  decisionType: nullableBoundedString(512),
};
const page = <T extends Parameters<typeof t.Array>[0]>(
  item: T,
  maxItems: number,
) =>
  t.Object(
    {
      items: t.Array(item, { maxItems }),
      limit: t.Number(),
      nextCursor: nullableBoundedString(4096),
    },
    { additionalProperties: false },
  );
// A sitemap answers one whole index or shard: its limit is the fixed capacity
// and there is never a next page.
const sitemapPage = <
  T extends Parameters<typeof t.Array>[0],
  TLimit extends number,
>(
  item: T,
  limit: TLimit,
) =>
  t.Object(
    {
      items: t.Array(item, { maxItems: limit }),
      limit: t.Literal(limit),
      nextCursor: t.Null(),
    },
    { additionalProperties: false },
  );
export const listDecisionsResponseSchema = page(
  t.Object(
    {
      ...decision,
      caseNumberType: t.UnionEnum(DECISION_PRIMARY_REFERENCE_TYPES),
      courtAbbreviation: nullableBoundedString(512),
      courtTier: t.UnionEnum(COURT_TIER_LABELS),
      sourceUrl: nullableBoundedString(8192),
      headnote,
      citationCount: t.Number(),
      createdAt: boundedString(128),
    } satisfies Record<
      keyof Success<typeof listDecisionsHandler>["items"][number],
      TSchema
    >,
    { additionalProperties: false },
  ),
  LIMITS.caseLawSearchPageSizeMax,
);
export const latestDecisionsResponseSchema = t.Object(
  {
    country: identity.country,
    courts: t.Array(
      t.Object(
        {
          court: identity.court,
          tierLabel: t.UnionEnum(SHELF_TIER_LABEL_VALUES),
          decisions: t.Array(
            t.Object(
              {
                ...decision,
                headnote,
                citationCount: t.Number(),
              } satisfies Record<keyof LatestDecision, TSchema>,
              { additionalProperties: false },
            ),
            { maxItems: LIMITS.caseLawLatestPerCourt },
          ),
        } satisfies Record<keyof LatestDecisionsByCourt, TSchema>,
        { additionalProperties: false },
      ),
      { maxItems: LIMITS.caseLawLatestCourts },
    ),
  } satisfies Record<keyof Success<typeof listLatestDecisionsHandler>, TSchema>,
  { additionalProperties: false },
);
const facet = t.Object(
  {
    value: boundedString(2048),
    label: t.Optional(boundedString(2048)),
    count: t.Number(),
  } satisfies Record<keyof FacetBucket, TSchema>,
  { additionalProperties: false },
);
export const decisionFacetsResponseSchema = t.Object(
  {
    country: t.Array(facet, { maxItems: LIMITS.caseLawFacetLimit }),
    court: t.Array(facet, { maxItems: LIMITS.caseLawFacetLimit }),
    year: t.Array(facet, { maxItems: LIMITS.caseLawYearFacetLimit }),
  } satisfies Record<keyof Success<typeof listDecisionFacetsHandler>, TSchema>,
  { additionalProperties: false },
);
const activity = {
  decisions: t.Number(),
  addedLastDay: t.Number(),
  addedLastWeek: t.Number(),
  updatedAt: date,
};
const courtStatus = t.Union([
  t.Object(
    {
      type: t.Literal("court"),
      court: identity.court,
      courtAbbreviation: nullableBoundedString(512),
      tier: t.UnionEnum(COURT_TIER_LABELS),
      ...activity,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      type: t.Literal("tier"),
      tier: t.UnionEnum(COURT_TIER_LABELS),
      courts: t.Number(),
      ...activity,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      type: t.Literal("unlisted"),
      tier: t.Literal("other"),
      listed: t.Number(),
      decisions: t.Number(),
    },
    { additionalProperties: false },
  ),
]);
const courts = t.Array(courtStatus, { maxItems: LIMITS.caseLawFacetLimit + 1 });
export const corpusStatusResponseSchema = t.Object(
  {
    decisions: t.Number(),
    updatedAt: date,
    courts,
  } satisfies Record<
    keyof Success<typeof readCaseLawCorpusStatusHandler>,
    TSchema
  >,
  { additionalProperties: false },
);
const relatedDecision = t.Object(
  {
    ...decision,
    caseNumberType: t.UnionEnum(DECISION_PRIMARY_REFERENCE_TYPES),
    citationAuthority: t.Number(),
  } satisfies Record<
    keyof NonNullable<DecisionCitationRow["decision"]>,
    TSchema
  >,
  { additionalProperties: false },
);
const citation = t.Object(
  {
    id: tSafeId("caseLawCitation"),
    citationText: boundedString(16_384),
    sectionIndex: numberOrNull,
    treatment: t.UnionEnum(CITATION_TREATMENTS),
    decision: t.Union([relatedDecision, t.Null()]),
  } satisfies Record<keyof DecisionCitationRow, TSchema>,
  { additionalProperties: false },
);
// A leading citation always names a held decision; only the general list
// carries unresolved rows.
const leadingCitation = t.Object(
  {
    id: tSafeId("caseLawCitation"),
    citationText: boundedString(16_384),
    sectionIndex: numberOrNull,
    treatment: t.UnionEnum(CITATION_TREATMENTS),
    decision: relatedDecision,
  } satisfies Record<keyof LeadingCitationRow, TSchema>,
  { additionalProperties: false },
);
export const citationsResponseSchema = page(
  citation,
  LIMITS.caseLawSearchPageSizeMax,
);
export const leadingCitationsResponseSchema = t.Object(
  {
    items: t.Array(leadingCitation, {
      maxItems: CITATION_TREATMENTS.length * LEADING_CITATIONS_PER_TREATMENT,
    }),
  } satisfies Record<
    keyof Success<typeof listLeadingCitationsHandler>,
    TSchema
  >,
  { additionalProperties: false },
);
const treatmentCounts = {
  negative: t.Number(),
  neutral: t.Number(),
  positive: t.Number(),
  supportive: t.Number(),
  mixed: t.Number(),
  unclassified: t.Number(),
};
export const citationSummaryResponseSchema = t.Object(
  {
    incoming: t.Object(treatmentCounts, { additionalProperties: false }),
    outgoing: t.Object(treatmentCounts, { additionalProperties: false }),
    precision: t.Union([
      t.Object({ status: t.Literal("exact") }, { additionalProperties: false }),
      t.Object(
        {
          status: t.Literal("bounded"),
          capped: t.Object(
            { incoming: t.Boolean(), outgoing: t.Boolean() },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ]),
    incomingByYear: t.Array(
      t.Object(
        { ...treatmentCounts, year: t.Number() },
        { additionalProperties: false },
      ),
      {
        maxItems: CITATION_TIMELINE_MAX_YEARS,
      },
    ),
  } satisfies Record<
    keyof Success<typeof summarizeDecisionCitationsHandler>,
    TSchema
  >,
  { additionalProperties: false },
);
export const sitemapShardsResponseSchema = sitemapPage(
  t.Object(
    {
      bucket: boundedString(128),
      country: boundedString(12),
      lastmod: date,
      month: boundedString(8),
      year: boundedString(32),
    } satisfies Record<
      keyof Success<typeof listSitemapShardsHandler>["items"][number],
      TSchema
    >,
    { additionalProperties: false },
  ),
  LIMITS.caseLawSitemapIndexEntryLimit,
);
const sitemapDecision = { ...identity, updatedAt: boundedString(128) };
export const sitemapDecisionsResponseSchema = sitemapPage(
  t.Object(
    {
      ...sitemapDecision,
      languageAlternates: t.Array(
        t.Object(sitemapDecision, { additionalProperties: false }),
        {
          maxItems: LIMITS.caseLawLanguageAlternatesPerGroupMax,
        },
      ),
    } satisfies Record<
      keyof Success<typeof listSitemapShardDecisionsHandler>["items"][number],
      TSchema
    >,
    { additionalProperties: false },
  ),
  LIMITS.caseLawSitemapShardUrlLimit,
);
const stored = t.Object(
  { decisions: t.Number(), asOf: date },
  { additionalProperties: false },
);
const completeness = t.Object(
  {
    measuredSources: t.Number(),
    stored: t.Number(),
    reported: t.Number(),
    storedAsOf: date,
    staleSources: t.Number(),
    notMeasuredSources: t.Number(),
    notCountedSources: t.Number(),
  },
  { additionalProperties: false },
);
const measurement = {
  stored: t.Number(),
  storedAsOf: boundedString(128),
  reported: t.Number(),
  reportedAsOf: boundedString(128),
  reportedBy: t.Enum(CASE_LAW_TOTAL_REPORTER),
};
const sourceCompleteness = t.Union([
  t.Object(
    { state: t.Literal("measured"), ...measurement },
    { additionalProperties: false },
  ),
  t.Object(
    { state: t.Literal("stale"), ...measurement },
    { additionalProperties: false },
  ),
  t.Object(
    { state: t.Literal("not-measured-yet") },
    { additionalProperties: false },
  ),
  t.Object(
    { state: t.Literal("not-counted-yet") },
    { additionalProperties: false },
  ),
]);
const countryCoverage = {
  // An enum record keeps the literal union; a mapped array would widen it.
  country: t.Enum(
    Object.fromEntries(
      CASE_LAW_JURISDICTIONS.map((country) => [country, country]),
    ),
  ),
  health: t.Enum(CASE_LAW_COVERAGE_HEALTH),
  stored,
  addedLastWeek: numberOrNull,
  completeness,
  sources: t.Array(
    t.Object(
      {
        adapterKey: boundedString(512),
        name: boundedString(2048),
        publicHomeUrl: boundedString(8192),
        health: t.Enum(CASE_LAW_COVERAGE_HEALTH),
        lastSyncAt: date,
        completeness: sourceCompleteness,
        addedLastWeek: numberOrNull,
      },
      { additionalProperties: false },
    ),
    { maxItems: CASE_LAW_SOURCE_ROWS_BOUND },
  ),
};
export const coverageResponseSchema = t.Object(
  {
    generatedAt: boundedString(128),
    totals: t.Object(
      { searchable: t.Number(), stored },
      { additionalProperties: false },
    ),
    countries: t.Array(
      t.Union([
        t.Object(
          {
            ...countryCoverage,
            availability: t.Literal("searchable"),
            searchable: t.Number(),
            decisionYearFrom: numberOrNull,
            decisionYearTo: numberOrNull,
            courts: t.Union([courts, t.Null()]),
          },
          { additionalProperties: false },
        ),
        t.Object(
          {
            ...countryCoverage,
            availability: t.Literal("in-preparation"),
          },
          { additionalProperties: false },
        ),
      ]),
      { maxItems: CASE_LAW_JURISDICTIONS.length },
    ),
  } satisfies Record<keyof Success<typeof readCaseLawCoverageHandler>, TSchema>,
  { additionalProperties: false },
);
