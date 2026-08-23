export const PUBLIC_LAW_SHARED_QUERY = {
  caseLawCorpusIndexRehydration: "case-law.corpus-index-rehydration",
  caseLawDocumentContext: "case-law.document-context",
  caseLawNonRedistributableSources: "case-law.non-redistributable-sources",
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
