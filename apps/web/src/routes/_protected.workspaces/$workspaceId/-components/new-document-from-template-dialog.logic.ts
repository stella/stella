import { filterBySearchQuery } from "@stll/text-normalize/search-query-matcher";

type TemplateWithName = {
  name: string;
};

export const filterTemplatesByName = <T extends TemplateWithName>(
  templates: readonly T[],
  query: string,
) =>
  filterBySearchQuery({
    items: templates,
    query,
    fields: ({ name }) => [name],
  });
