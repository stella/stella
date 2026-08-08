import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import type { QueryOptionsInput } from "@/lib/react-query";

type UsageEntitlementKey = {
  organizationId: string;
};

export const usageEntitlementKeys = {
  all: ["usage", "entitlement"] as const,
  byOrganization: ({ organizationId }: UsageEntitlementKey) => [
    ...usageEntitlementKeys.all,
    organizationId,
  ],
};

type UsageOverviewKey = {
  organizationId: string;
};

export const usageOverviewKeys = {
  all: ["usage", "overview"] as const,
  byOrganization: ({ organizationId }: UsageOverviewKey) => [
    ...usageOverviewKeys.all,
    organizationId,
  ],
};

type UsageEntitlementOptionsInput = QueryOptionsInput<UsageEntitlementKey>;
type UsageOverviewOptionsInput = QueryOptionsInput<UsageOverviewKey>;

/** The org's usage entitlement state; `{ entitlement: null }` when absent. */
export type UsageEntitlementResponse = NonNullable<
  Awaited<ReturnType<typeof api.usage.entitlement.get>>["data"]
>;

export type UsageEntitlement = Exclude<
  UsageEntitlementResponse,
  { entitlement: null }
>;

export type UsageOverviewResponse = NonNullable<
  Awaited<ReturnType<typeof api.usage.overview.get>>["data"]
>;

const fetchUsageEntitlement = async ({
  signal,
}: {
  signal: AbortSignal;
}): Promise<UsageEntitlementResponse> => {
  const response = await api.usage.entitlement.get({
    fetch: { signal },
  });
  return unwrapEden(response);
};

const fetchUsageOverview = async ({
  signal,
}: {
  signal: AbortSignal;
}): Promise<UsageOverviewResponse> => {
  const response = await api.usage.overview.get({ fetch: { signal } });
  return unwrapEden(response);
};

export const usageEntitlementOptions = ({
  organizationId,
}: UsageEntitlementOptionsInput) =>
  queryOptions({
    queryKey: usageEntitlementKeys.byOrganization({ organizationId }),
    queryFn: fetchUsageEntitlement,
  });

export const usageOverviewOptions = ({
  organizationId,
}: UsageOverviewOptionsInput) =>
  queryOptions({
    queryKey: usageOverviewKeys.byOrganization({ organizationId }),
    queryFn: fetchUsageOverview,
  });
