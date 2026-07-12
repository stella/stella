import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const organizationSettingsKeys = {
  all: ["organization-settings"],
  byOrganization: (organizationId: string) => [
    ...organizationSettingsKeys.all,
    organizationId,
  ],
};

export const organizationSettingsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: organizationSettingsKeys.byOrganization(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"].get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
