import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

type EntityWithOptionalName = {
  name: string | null;
};

export const filterEntitiesByName = <T extends EntityWithOptionalName>(
  entities: readonly T[],
  query: string,
) => {
  const normalizedQuery = query.toLowerCase();
  return entities.filter((entity) =>
    containsSearchMatchKey((entity.name ?? "").toLowerCase(), normalizedQuery),
  );
};
