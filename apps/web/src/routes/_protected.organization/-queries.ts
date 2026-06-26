import { queryOptions } from "@tanstack/react-query";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { ORGANIZATION_MEMBERS_LIMIT } from "@/routes/_protected.organization/-consts";

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
      const result = await authClient.organization.getFullOrganization({
        query: {
          membersLimit: ORGANIZATION_MEMBERS_LIMIT,
        },
      });

      if (result.error) {
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
