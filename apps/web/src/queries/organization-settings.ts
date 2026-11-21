import { queryOptions, skipToken } from "@tanstack/react-query";
import type { QueryFunctionContext } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
import { organizationSettingsKeys } from "@/queries/organization-settings-keys.logic";
import type {
  OptionalOrganizationSettingsCaller,
  OrganizationSettingsCaller,
} from "@/queries/organization-settings-keys.logic";

export { organizationSettingsKeys } from "@/queries/organization-settings-keys.logic";

const fetchOrganizationSettings = async ({ signal }: QueryFunctionContext) => {
  const response = await api["organization-settings"].get({
    fetch: { signal },
  });
  return unwrapApiResponse(response);
};

export type OrganizationSettings = Awaited<
  ReturnType<typeof fetchOrganizationSettings>
>;

export const organizationSettingsOptions = ({
  organizationId,
  userId,
}: OrganizationSettingsCaller) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: organizationSettingsKeys.byCaller({ organizationId, userId }),
      queryFn: fetchOrganizationSettings,
      staleTime: ROUTE_QUERY_STALE_TIME_MS,
    }),
    {
      resources: [RESOURCE_TYPE.ORGANIZATION],
      scope: { type: "organization", organizationId, userId },
    },
  );

export const optionalOrganizationSettingsOptions = ({
  organizationId,
  userId,
}: OptionalOrganizationSettingsCaller) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: organizationSettingsKeys.byCaller({ organizationId, userId }),
      queryFn: organizationId === null ? skipToken : fetchOrganizationSettings,
      staleTime: ROUTE_QUERY_STALE_TIME_MS,
    }),
    organizationId === null
      ? { type: "independent" }
      : {
          resources: [RESOURCE_TYPE.ORGANIZATION],
          scope: { type: "organization", organizationId, userId },
        },
  );
