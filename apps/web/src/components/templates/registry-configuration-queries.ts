import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const businessRegistryConfigurationKeys = {
  scoped: (organizationId: string) =>
    ["business-registry-configuration", organizationId] as const,
};

export const businessRegistryConfigurationOptions = ({
  organizationId,
  enabled,
}: {
  organizationId: string;
  enabled: boolean;
}) =>
  queryOptions({
    queryKey: businessRegistryConfigurationKeys.scoped(organizationId),
    enabled,
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api["organization-settings"]["business-registry-credentials"].get(
          {
            fetch: { signal },
          },
        ),
      ),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    retry: false,
  });
