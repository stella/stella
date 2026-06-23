import { queryOptions } from "@tanstack/react-query";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const organizationKeys = {
  all: ["organization", "full"],
  byOrganization: (organizationId: string) => [
    ...organizationKeys.all,
    organizationId,
  ],
};

export const organizationOptions = (organizationId: string) =>
  queryOptions({
    queryKey: organizationKeys.byOrganization(organizationId),
    queryFn: async () => {
      const result = await authClient.organization.getFullOrganization();

      if (result.error) {
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
