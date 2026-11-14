import { filterBySearchQuery } from "@stll/text-normalize/search-query-matcher";

type EntityWithOptionalName = {
  name: string | null;
};

export const filterEntitiesByName = <T extends EntityWithOptionalName>(
  entities: readonly T[],
  query: string,
) =>
  filterBySearchQuery({
    items: entities,
    query,
    fields: ({ name }) => [name],
  });
