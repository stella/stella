import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

type MentionOption = {
  label: string;
};

export const filterMentionItems = <T extends MentionOption>(
  mentionItems: readonly T[],
  query: string,
) => {
  const normalizedQuery = query.toLowerCase();
  return mentionItems.filter((item) =>
    containsSearchMatchKey(item.label.toLowerCase(), normalizedQuery),
  );
};
