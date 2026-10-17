import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

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
  const query = search.toLowerCase();
  return clauses.filter((clause) => {
    if (selectedCategory && clause.categoryId !== selectedCategory) {
      return false;
    }
    return !search || containsSearchMatchKey(clause.title.toLowerCase(), query);
  });
};
