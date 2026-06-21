import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type { ConditionNode } from "@/lib/types";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";

export type PropertyFacetsKey = {
  workspaceId: string;
  propertyId: string;
  filters: ConditionNode[];
};

export const propertyFacetsKeys = {
  facets: ({ workspaceId, propertyId, filters }: PropertyFacetsKey) => [
    ...entitiesKeys.all(workspaceId),
    "property-facets",
    { propertyId, filters },
  ],
};

type PropertyFacetsOptionsInput = QueryOptionsInput<PropertyFacetsKey>;

export type PropertyFacetCounts = {
  counts: Map<string, number>;
  truncated: boolean;
};

export const propertyFacetsOptions = (key: PropertyFacetsOptionsInput) =>
  queryOptions({
    queryKey: propertyFacetsKeys.facets(key),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        ["property-facets"].post(
          {
            propertyId: toSafeId<"property">(key.propertyId),
            filters: key.filters,
          },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      const counts = new Map<string, number>();
      for (const entry of response.data.values) {
        counts.set(entry.value, entry.count);
      }

      return { counts, truncated: response.data.truncated };
    },
  });
