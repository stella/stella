import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

type SearchableCommandAction = {
  keywordLabels: readonly string[];
  title: string;
};

type FilterCommandActionsOptions<TAction extends SearchableCommandAction> = {
  actions: readonly TAction[];
  mode: "browse" | "pick";
  query: string;
};

export const filterCommandActions = <TAction extends SearchableCommandAction>({
  actions,
  mode,
  query,
}: FilterCommandActionsOptions<TAction>): TAction[] => {
  if (mode !== "browse") {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  return actions.filter(
    (action) =>
      normalizedQuery.length === 0 ||
      containsSearchMatchKey(action.title.toLowerCase(), normalizedQuery) ||
      action.keywordLabels.some((keyword) =>
        containsSearchMatchKey(keyword.toLowerCase(), normalizedQuery),
      ),
  );
};
