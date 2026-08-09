import { queryOptions } from "@tanstack/react-query";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors/auth";
import { ORGANIZATION_MEMBERS_LIMIT } from "@/lib/organization/consts";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { organizationQueryRoot } from "@/lib/resource-query-roots.logic";

const ORGANIZATION_KEY_ROOT = organizationQueryRoot();

export const organizationKeys = {
  root: ORGANIZATION_KEY_ROOT,
  all: [...ORGANIZATION_KEY_ROOT, "full"],
  byOrganization: (organizationId: string) => [
    ...organizationKeys.all,
    organizationId,
  ],
  list: [...ORGANIZATION_KEY_ROOT, "list"],
};

/** Every organization the signed-in user belongs to.
 *
 * Single source for both the sidebar's active-organization label and its
 * organization switcher: `organization/list` returns the whole membership
 * list, so keying it per organization would issue one identical request per
 * consumer and blow the per-route network baseline. Consumers narrow to the
 * active organization client-side. */
export const organizationListOptions = queryOptions({
  queryKey: organizationKeys.list,
  queryFn: async () => {
    const result = await authClient.organization.list();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data;
  },
  staleTime: ROUTE_QUERY_STALE_TIME_MS,
});

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
