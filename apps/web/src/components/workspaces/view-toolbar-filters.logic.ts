import { filterBySearchQuery } from "@stll/text-normalize/search-query-matcher";

type FilterField = {
  label: string;
};

export const filterFieldsByLabel = <T extends FilterField>(
  fields: readonly T[],
  query: string,
) =>
  filterBySearchQuery({
    items: fields,
    query,
    fields: ({ label }) => [label],
  });
