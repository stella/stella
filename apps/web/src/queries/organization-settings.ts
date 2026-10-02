import { queryOptions, skipToken } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { organizationSettingsQueryRoot } from "@/lib/resource-query-roots.logic";

type OrganizationSettingsCaller = {
  organizationId: string | null;
  userId: string;
};

export const organizationSettingsKeys = {
  all: organizationSettingsQueryRoot(),
  byOrganization: (organizationId: string | null) => [
    ...organizationSettingsKeys.all,
    organizationId,
  ],
  byCaller: ({ organizationId, userId }: OrganizationSettingsCaller) => [
    ...organizationSettingsKeys.byOrganization(organizationId),
    userId,
  ],
};

export const organizationSettingsOptions = ({
  organizationId,
  userId,
}: OrganizationSettingsCaller) =>
  queryOptions({
    queryKey: organizationSettingsKeys.byCaller({ organizationId, userId }),
    queryFn:
      organizationId === null
        ? skipToken
        : async ({ signal }) => {
            const response = await api["organization-settings"].get({
              fetch: { signal },
            });

            return unwrapEden(response);
          },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
