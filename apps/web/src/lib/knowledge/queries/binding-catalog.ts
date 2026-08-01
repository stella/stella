import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { toAPIError } from "@/lib/errors/api";

// The binding catalog is the same static taxonomy for every org, so it carries
// no params and a single global cache entry.
export const bindingCatalogKeys = {
  all: () => ["binding-catalog"] as const,
};

export const bindingCatalogOptions = () =>
  queryOptions({
    queryKey: bindingCatalogKeys.all(),
    queryFn: async ({ signal }) => {
      const response = await api.templates["binding-catalog"].get({
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
