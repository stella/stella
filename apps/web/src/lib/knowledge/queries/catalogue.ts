import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapEden } from "@/lib/errors/api";
import { catalogueQueryRoot } from "@/lib/resource-query-roots.logic";

export const catalogueKeys = {
  root: catalogueQueryRoot(),
  all: (organizationId: string) =>
    [...catalogueKeys.root, organizationId] as const,
  list: (organizationId: string) =>
    [...catalogueKeys.all(organizationId), "list"] as const,
};

export const catalogueOptions = (organizationId: string) =>
  queryOptions({
    queryKey: catalogueKeys.list(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api.catalogue.get({ fetch: { signal } });
      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
