import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";

export const catalogueKeys = {
  all: (organizationId: string) => ["catalogue", organizationId] as const,
  list: (organizationId: string) =>
    [...catalogueKeys.all(organizationId), "list"] as const,
};

export const catalogueOptions = (organizationId: string) =>
  queryOptions({
    queryKey: catalogueKeys.list(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api.catalogue.get({ fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
