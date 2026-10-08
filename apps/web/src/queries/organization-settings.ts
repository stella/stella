import { queryOptions, skipToken } from "@tanstack/react-query";
import type { QueryFunctionContext } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { organizationSettingsQueryRoot } from "@/lib/resource-query-roots.logic";

type OrganizationSettingsCaller = {
  organizationId: string;
  userId: string;
};

type OptionalOrganizationSettingsCaller = Omit<
  OrganizationSettingsCaller,
  "organizationId"
> & {
  organizationId: string | null;
};

export const organizationSettingsKeys = {
  all: organizationSettingsQueryRoot(),
  byOrganization: (organizationId: string | null) => [
    ...organizationSettingsKeys.all,
    organizationId,
  ],
  byCaller: ({
    organizationId,
    userId,
  }: OptionalOrganizationSettingsCaller) => [
    ...organizationSettingsKeys.byOrganization(organizationId),
    userId,
  ],
};

const fetchOrganizationSettings = async ({ signal }: QueryFunctionContext) => {
  const response = await api["organization-settings"].get({
    fetch: { signal },
  });
  return unwrapEden(response);
};

export type OrganizationSettings = Awaited<
  ReturnType<typeof fetchOrganizationSettings>
>;

export const organizationSettingsOptions = ({
  organizationId,
  userId,
}: OrganizationSettingsCaller) =>
  queryOptions({
    queryKey: organizationSettingsKeys.byCaller({ organizationId, userId }),
    queryFn: fetchOrganizationSettings,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const optionalOrganizationSettingsOptions = ({
  organizationId,
  userId,
}: OptionalOrganizationSettingsCaller) =>
  queryOptions({
    queryKey: organizationSettingsKeys.byCaller({ organizationId, userId }),
    queryFn: organizationId === null ? skipToken : fetchOrganizationSettings,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
