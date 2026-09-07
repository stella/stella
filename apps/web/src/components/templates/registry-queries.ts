import { queryOptions } from "@tanstack/react-query";

import type { LookupRegistryOption } from "@/components/templates/registry-options";
import { api } from "@/lib/api";
import { contactsKeys } from "@/lib/contacts/queries";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

type BusinessRegistryQueryOptions = {
  organizationId: string;
  registry: LookupRegistryOption["slug"];
  query: string;
};

export const businessRegistryQueryOptions = ({
  organizationId,
  registry,
  query,
}: BusinessRegistryQueryOptions) =>
  queryOptions({
    queryKey: [
      ...contactsKeys.scoped(organizationId),
      "business-registry",
      { registry, q: query },
    ],
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api.contacts["business-registries"].get({
          query: { registry, q: query },
          fetch: { signal },
        }),
      ),
    retry: false,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
