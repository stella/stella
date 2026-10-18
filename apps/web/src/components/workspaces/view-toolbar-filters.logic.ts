import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

type FilterField = {
  label: string;
};

export const filterFieldsByLabel = <T extends FilterField>(
  fields: readonly T[],
  query: string,
) => {
  const normalized = query.trim().toLowerCase();
  return normalized
    ? fields.filter((field) =>
        containsSearchMatchKey(field.label.toLowerCase(), normalized),
      )
    : fields;
};
