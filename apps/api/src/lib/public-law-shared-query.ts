export const PUBLIC_LAW_SHARED_QUERY = {
  caseLawAnalysis: "case-law.analysis",
  caseLawBrowseFacets: "case-law.browse-facets",
  caseLawCorpusIndexRehydration: "case-law.corpus-index-rehydration",
  caseLawCorpusStatus: "case-law.corpus-status",
  caseLawDecisionRead: "case-law.decision-read",
  caseLawDecisionTextPresence: "case-law.decision-text-presence",
  caseLawDocumentContext: "case-law.document-context",
  caseLawLanguageAlternates: "case-law.language-alternates",
  caseLawNonRedistributableSources: "case-law.non-redistributable-sources",
  legislationNonRedistributableSources:
    "legislation.non-redistributable-sources",
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
