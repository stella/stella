import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { DOCTRINAL_TREATMENTS } from "@stll/api-contract/case-law-doctrine";
import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { DECISION_PRIMARY_REFERENCE_TYPES } from "@stll/legal-ast/decision-identifier";

import type {
  DecisionCitationRow,
  LeadingCitationRow,
  listLeadingCitationsHandler,
  summarizeDecisionCitationsHandler,
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
import { CASE_LAW_COVERAGE_YEARS_PER_SOURCE_BOUND } from "@/api/handlers/case-law/decisions/coverage-years";
import type { listDecisionFacetsHandler } from "@/api/handlers/case-law/decisions/facets";
import type {
  LatestDecision,
  LatestDecisionsByCourt,
  listLatestDecisionsHandler,
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
import { resourceIdSchema } from "@/api/lib/custom-schema";
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
  id: resourceIdSchema("caseLawDecision"),
  caseNumber: boundedString(1024),
  slug: nullableBoundedString(1024),
  country: boundedString(12),
  court: boundedString(2048),
  language: boundedString(32),
};
const date = nullableBoundedString(128);
const numberOrNull = v.union([v.number(), v.null()]);
const headnote = decisionHeadnotePreviewSchema;
const decision = {
  ...identity,
  ecli: nullableBoundedString(1024),
  languageAlternates: languageAlternatesSchema,
  decisionDate: date,
  decisionType: nullableBoundedString(512),
};
const page = <T extends v.GenericSchema>(item: T, maxItems: number) =>
  v.object({
    items: v.pipe(v.array(item), v.maxLength(maxItems)),
    limit: v.number(),
    nextCursor: nullableBoundedString(4096),
  });
// A sitemap answers one whole index or shard: its limit is the fixed capacity
// and there is never a next page.
const sitemapPage = <T extends v.GenericSchema, TLimit extends number>(
  item: T,
  limit: TLimit,
) =>
  v.object({
    items: v.pipe(v.array(item), v.maxLength(limit)),
    limit: v.literal(limit),
    nextCursor: v.null(),
  });
export const listDecisionsResponseSchema = page(
  v.object({
    ...decision,
    caseNumberType: v.picklist(DECISION_PRIMARY_REFERENCE_TYPES),
    courtAbbreviation: nullableBoundedString(512),
    courtTier: v.picklist(COURT_TIER_LABELS),
    sourceUrl: nullableBoundedString(8192),
    headnote,
    citationCount: v.number(),
    createdAt: boundedString(128),
  } satisfies Record<
    keyof Success<typeof listDecisionsHandler>["items"][number],
    v.GenericSchema
  >),
  LIMITS.caseLawSearchPageSizeMax,
);
export const latestDecisionsResponseSchema = v.object({
  country: identity.country,
  courts: v.pipe(
    v.array(
      v.object({
        court: identity.court,
        tierLabel: v.picklist(SHELF_TIER_LABEL_VALUES),
        decisions: v.pipe(
          v.array(
            v.object({
              ...decision,
              headnote,
              citationCount: v.number(),
            } satisfies Record<keyof LatestDecision, v.GenericSchema>),
          ),
          v.maxLength(LIMITS.caseLawLatestPerCourt),
        ),
      } satisfies Record<keyof LatestDecisionsByCourt, v.GenericSchema>),
    ),
    v.maxLength(LIMITS.caseLawLatestCourts),
  ),
} satisfies Record<
  keyof Success<typeof listLatestDecisionsHandler>,
  v.GenericSchema
>);
const facet = v.object({
  value: boundedString(2048),
  label: v.exactOptional(boundedString(2048)),
  count: v.number(),
} satisfies Record<keyof FacetBucket, v.GenericSchema>);
export const decisionFacetsResponseSchema = v.object({
  country: v.pipe(v.array(facet), v.maxLength(LIMITS.caseLawFacetLimit)),
  court: v.pipe(v.array(facet), v.maxLength(LIMITS.caseLawFacetLimit)),
  year: v.pipe(v.array(facet), v.maxLength(LIMITS.caseLawYearFacetLimit)),
} satisfies Record<
  keyof Success<typeof listDecisionFacetsHandler>,
  v.GenericSchema
>);
const activity = {
  decisions: v.number(),
  addedLastDay: v.number(),
  addedLastWeek: v.number(),
  updatedAt: date,
};
const courtStatus = v.union([
  v.object({
    type: v.literal("court"),
    court: identity.court,
    courtAbbreviation: nullableBoundedString(512),
    tier: v.picklist(COURT_TIER_LABELS),
    ...activity,
  }),
  v.object({
    type: v.literal("tier"),
    tier: v.picklist(COURT_TIER_LABELS),
    courts: v.number(),
    ...activity,
  }),
  v.object({
    type: v.literal("other-courts"),
    tier: v.literal("other"),
    courts: v.union([v.number(), v.null()]),
    decisions: v.number(),
  }),
]);
const courts = v.pipe(
  v.array(courtStatus),
  v.maxLength(LIMITS.caseLawFacetLimit + 1),
);
export const corpusStatusResponseSchema = v.object({
  decisions: v.number(),
  updatedAt: date,
  health: v.enum(CASE_LAW_COVERAGE_HEALTH),
} satisfies Record<
  keyof Success<typeof readCaseLawCorpusStatusHandler>,
  v.GenericSchema
>);
const relatedDecision = v.object({
  ...decision,
  courtAbbreviation: nullableBoundedString(2048),
  sourceUrl: nullableBoundedString(8192),
  caseNumberType: v.picklist(DECISION_PRIMARY_REFERENCE_TYPES),
  citationAuthority: v.number(),
} satisfies Record<
  keyof NonNullable<DecisionCitationRow["decision"]>,
  v.GenericSchema
>);
const citation = v.object({
  id: resourceIdSchema("caseLawCitation"),
  citationText: boundedString(16_384),
  sectionIndex: numberOrNull,
  treatment: v.picklist(CITATION_TREATMENTS),
  doctrine: v.union([
    v.picklist([...DOCTRINAL_TREATMENTS, "unread"]),
    v.null(),
  ]),
  decision: v.union([relatedDecision, v.null()]),
} satisfies Record<
  keyof Omit<DecisionCitationRow, "evidenceQuote">,
  v.GenericSchema
>);
// A leading citation always names a held decision; only the general list
// carries unresolved rows.
const leadingCitation = v.object({
  id: resourceIdSchema("caseLawCitation"),
  citationText: boundedString(16_384),
  sectionIndex: numberOrNull,
  treatment: v.picklist(CITATION_TREATMENTS),
  decision: relatedDecision,
} satisfies Record<keyof LeadingCitationRow, v.GenericSchema>);
export const citationsResponseSchema = v.object({
  ...page(citation, LIMITS.caseLawSearchPageSizeMax).entries,
  doctrineAvailability: v.picklist(["available", "unavailable"]),
});
export const leadingCitationsResponseSchema = v.object({
  items: v.pipe(
    v.array(leadingCitation),
    v.maxLength(CITATION_TREATMENTS.length * LEADING_CITATIONS_PER_TREATMENT),
  ),
} satisfies Record<
  keyof Success<typeof listLeadingCitationsHandler>,
  v.GenericSchema
>);
const treatmentCounts = {
  negative: v.number(),
  neutral: v.number(),
  positive: v.number(),
  supportive: v.number(),
  mixed: v.number(),
  unclassified: v.number(),
};
export const citationSummaryResponseSchema = v.object({
  incoming: v.object(treatmentCounts),
  outgoing: v.object(treatmentCounts),
  precision: v.union([
    v.object({ status: v.literal("exact") }),
    v.object({
      status: v.literal("bounded"),
      capped: v.object({ incoming: v.boolean(), outgoing: v.boolean() }),
    }),
  ]),
  incomingByYear: v.pipe(
    v.array(v.object({ ...treatmentCounts, year: v.number() })),
    v.maxLength(CITATION_TIMELINE_MAX_YEARS),
  ),
} satisfies Record<
  keyof Success<typeof summarizeDecisionCitationsHandler>,
  v.GenericSchema
>);
export const sitemapShardsResponseSchema = sitemapPage(
  v.object({
    bucket: boundedString(128),
    country: boundedString(12),
    lastmod: date,
    month: boundedString(8),
    year: boundedString(32),
  } satisfies Record<
    keyof Success<typeof listSitemapShardsHandler>["items"][number],
    v.GenericSchema
  >),
  LIMITS.caseLawSitemapIndexEntryLimit,
);
const sitemapDecision = { ...identity, updatedAt: boundedString(128) };
export const sitemapDecisionsResponseSchema = sitemapPage(
  v.object({
    ...sitemapDecision,
    languageAlternates: v.pipe(
      v.array(v.object(sitemapDecision)),
      v.maxLength(LIMITS.caseLawLanguageAlternatesPerGroupMax),
    ),
  } satisfies Record<
    keyof Success<typeof listSitemapShardDecisionsHandler>["items"][number],
    v.GenericSchema
  >),
  LIMITS.caseLawSitemapShardUrlLimit,
);
const stored = v.object({ decisions: v.number(), asOf: date });
const completeness = v.object({
  measuredSources: v.number(),
  stored: v.number(),
  reported: v.number(),
  storedAsOf: date,
  staleSources: v.number(),
  notMeasuredSources: v.number(),
  notCountedSources: v.number(),
});
const measurement = {
  stored: v.number(),
  storedAsOf: boundedString(128),
  reported: v.number(),
  reportedAsOf: boundedString(128),
  reportedBy: v.enum(CASE_LAW_TOTAL_REPORTER),
};
const sourceCompleteness = v.union([
  v.object({ state: v.literal("measured"), ...measurement }),
  v.object({ state: v.literal("stale"), ...measurement }),
  v.object({ state: v.literal("not-measured-yet") }),
  v.object({ state: v.literal("not-counted-yet") }),
]);
const countryCoverage = {
  // An enum record keeps the literal union; a mapped array would widen it.
  country: v.enum(
    Object.fromEntries(
      CASE_LAW_JURISDICTIONS.map((country) => [country, country]),
    ),
  ),
  health: v.enum(CASE_LAW_COVERAGE_HEALTH),
  stored,
  addedLastWeek: numberOrNull,
  completeness,
  sources: v.pipe(
    v.array(
      v.object({
        adapterKey: boundedString(512),
        name: boundedString(2048),
        publicHomeUrl: boundedString(8192),
        health: v.enum(CASE_LAW_COVERAGE_HEALTH),
        edition: v.variant("type", [
          v.object({ type: v.literal("live") }),
          v.object({
            type: v.literal("snapshot"),
            snapshotDate: boundedString(10),
          }),
        ]),
        lastSyncAt: date,
        decisionYearFrom: numberOrNull,
        decisionYearTo: numberOrNull,
        pendingTextCount: v.number(),
        storedDecisions: numberOrNull,
        publishedDecisions: v.number(),
        courts: v.pipe(
          v.array(
            v.object({
              court: v.nullable(identity.court),
              decisions: v.number(),
            }),
          ),
          v.maxLength(LIMITS.caseLawFacetLimit + 1),
        ),
        knownGaps: v.union([
          v.object({
            type: v.literal("not_reconciled"),
            reason: boundedString(2048),
          }),
          v.object({
            type: v.literal("reconciled"),
            summary: v.object({
              missing: v.number(),
              shortSlices: v.number(),
              unlistedSlices: v.number(),
            }),
            years: v.pipe(
              v.array(
                v.union([
                  v.object({ year: v.number(), type: v.literal("complete") }),
                  v.object({
                    year: v.number(),
                    type: v.literal("gaps"),
                    missing: v.number(),
                    shortSlices: v.number(),
                  }),
                  v.object({
                    year: v.number(),
                    type: v.literal("unlisted"),
                    missing: v.number(),
                    shortSlices: v.number(),
                    unlistedSlices: v.number(),
                  }),
                ]),
              ),
              v.maxLength(CASE_LAW_COVERAGE_YEARS_PER_SOURCE_BOUND),
            ),
          }),
        ]),
        completeness: sourceCompleteness,
        addedLastWeek: numberOrNull,
      }),
    ),
    v.maxLength(CASE_LAW_SOURCE_ROWS_BOUND),
  ),
};
const provisionProcessingState = v.union([
  v.object({
    type: v.literal("available"),
    pendingCount: boundedString(128),
    oldestPendingAt: nullableBoundedString(128),
    sampledAt: boundedString(128),
    revision: v.number(),
    scopeGeneration: v.number(),
  }),
  v.object({
    type: v.literal("notSupportedYet"),
    reason: v.picklist([
      "no_profile",
      "no_multilingual_profile",
      "language_not_supported",
      "unknown_jurisdiction",
    ]),
  }),
  v.object({
    type: v.literal("unavailable"),
    reason: v.picklist([
      "state_not_seeded",
      "scope_inactive",
      "revision_unavailable",
      "read_failed",
    ]),
    lastSampledAt: nullableBoundedString(128),
  }),
]);

export const coverageResponseSchema = v.object({
  generatedAt: boundedString(128),
  provisionProcessing: v.pipe(
    v.array(
      v.object({
        country: countryCoverage.country,
        state: provisionProcessingState,
      }),
    ),
    v.maxLength(CASE_LAW_JURISDICTIONS.length),
  ),
  totals: v.object({
    addedLastWeek: v.nullable(v.number()),
    searchable: v.nullable(v.number()),
    stored,
  }),
  countries: v.pipe(
    v.array(
      v.union([
        v.object({
          ...countryCoverage,
          availability: v.literal("searchable"),
          searchable: v.number(),
          decisionYearFrom: numberOrNull,
          decisionYearTo: numberOrNull,
          courts: v.union([courts, v.null()]),
        }),
        v.object({
          ...countryCoverage,
          availability: v.literal("in-preparation"),
        }),
      ]),
    ),
    v.maxLength(CASE_LAW_JURISDICTIONS.length),
  ),
} satisfies Record<
  keyof Success<typeof readCaseLawCoverageHandler>,
  v.GenericSchema
>);
