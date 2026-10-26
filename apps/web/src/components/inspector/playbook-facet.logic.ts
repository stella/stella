import { filterBySearchQuery } from "@stll/text-normalize";

type PlaybookWithName = {
  name: string;
};

export const filterPlaybooksByName = <T extends PlaybookWithName>(
  playbooks: readonly T[],
  query: string,
) =>
  filterBySearchQuery({
    items: playbooks,
    query,
    fields: ({ name }) => [name],
  });
