import { filterBySearchQuery } from "@stll/text-normalize";

type MentionOption = {
  label: string;
};

export const filterMentionItems = <T extends MentionOption>(
  mentionItems: readonly T[],
  query: string,
) =>
  filterBySearchQuery({
    items: mentionItems,
    query,
    fields: ({ label }) => [label],
  });
