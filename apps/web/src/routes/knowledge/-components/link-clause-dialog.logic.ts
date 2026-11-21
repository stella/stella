import { createSearchQueryMatcher } from "@stll/text-normalize/search-query-matcher";

type ClauseLinkCandidate = {
  categoryId: string | null;
  title: string;
};

type FilterClauseLinkCandidatesOptions<T> = {
  clauses: readonly T[];
  selectedCategory: string;
  search: string;
};

export const filterClauseLinkCandidates = <T extends ClauseLinkCandidate>({
  clauses,
  selectedCategory,
  search,
}: FilterClauseLinkCandidatesOptions<T>): T[] => {
  const matches = createSearchQueryMatcher(search);
  return clauses.filter(
    (clause) =>
      (!selectedCategory || clause.categoryId === selectedCategory) &&
      matches(clause.title),
  );
};
