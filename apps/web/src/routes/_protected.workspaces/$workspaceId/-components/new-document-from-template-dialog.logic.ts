import { filterBySearchQuery } from "@stll/text-normalize";

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
