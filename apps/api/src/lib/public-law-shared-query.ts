export const PUBLIC_LAW_SHARED_QUERY = {
  caseLawAnalysis: "case-law.analysis",
  caseLawBrowseFacets: "case-law.browse-facets",
  caseLawCorpusIndexRehydration: "case-law.corpus-index-rehydration",
  caseLawCorpusStatus: "case-law.corpus-status",
  caseLawCourtActivity: "case-law.court-activity",
  caseLawCourtCount: "case-law.court-count",
  caseLawCourtWeights: "case-law.court-weights",
  caseLawCoverageArrivals: "case-law.coverage-arrivals",
  caseLawCoverageSummary: "case-law.coverage-summary",
  caseLawCoverageSources: "case-law.coverage-sources",
  caseLawDecisionRead: "case-law.decision-read",
  caseLawDecisionTextPresence: "case-law.decision-text-presence",
  caseLawDocumentContext: "case-law.document-context",
  caseLawFtsConfigs: "case-law.fts-configs",
  caseLawLanguageAlternates: "case-law.language-alternates",
  caseLawNonRedistributableSources: "case-law.non-redistributable-sources",
  caseLawProviderSearchFacet: "case-law.provider-search-facet",
  caseLawProviderSearchHits: "case-law.provider-search-hits",
  caseLawSearchFacet: "case-law.search-facet",
  caseLawSearchHits: "case-law.search-hits",
  caseLawSearchTotal: "case-law.search-total",
  caseLawSourceHealth: "case-law.source-health",
  legislationNonRedistributableSources:
    "legislation.non-redistributable-sources",
  legislationSearchHits: "legislation.search-hits",
} as const;

export type PublicLawSharedQuery =
  (typeof PUBLIC_LAW_SHARED_QUERY)[keyof typeof PUBLIC_LAW_SHARED_QUERY];

type PublicLawSharedQueryCallback<TArgs extends unknown[], TResult> = ((
  ...args: TArgs
) => Promise<TResult>) & {
  publicLawSharedQuery: PublicLawSharedQuery;
};

export const definePublicLawSharedQuery = <TArgs extends unknown[], TResult>(
  query: PublicLawSharedQuery,
  callback: (...args: TArgs) => Promise<TResult>,
): PublicLawSharedQueryCallback<TArgs, TResult> =>
  Object.assign(callback, { publicLawSharedQuery: query });
