import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

type TemplateWithName = {
  name: string;
};

export const filterTemplatesByName = <T extends TemplateWithName>(
  templates: readonly T[],
  query: string,
) => {
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery === ""
    ? templates
    : templates.filter((template) =>
        containsSearchMatchKey(template.name.toLowerCase(), normalizedQuery),
      );
};
