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

type UsageEntitlementOptionsInput = QueryOptionsInput<UsageEntitlementKey>;

/** The org's usage entitlement state; `{ entitlement: null }` when absent. */
export type UsageEntitlementResponse = NonNullable<
  Awaited<ReturnType<typeof api.usage.entitlement.get>>["data"]
>;

export type UsageEntitlement = Exclude<
  UsageEntitlementResponse,
  { entitlement: null }
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

export const usageEntitlementOptions = ({
  organizationId,
}: UsageEntitlementOptionsInput) =>
  queryOptions({
    queryKey: usageEntitlementKeys.byOrganization({ organizationId }),
    queryFn: fetchUsageEntitlement,
  });

type UsageLaneKey = {
  organizationId: string;
};

export const usageLaneKeys = {
  all: ["usage", "lane"] as const,
  byOrganization: ({ organizationId }: UsageLaneKey) => [
    ...usageLaneKeys.all,
    organizationId,
  ],
};

type UsageLaneOptionsInput = QueryOptionsInput<UsageLaneKey>;

/**
 * The calling user's own budget-lane state; `{ budgets: null }` when the
 * organization's plan declares no per-user budgets.
 */
export type UsageLaneResponse = NonNullable<
  Awaited<ReturnType<typeof api.usage.lane.get>>["data"]
>;

const fetchUsageLane = async ({
  signal,
}: {
  signal: AbortSignal;
}): Promise<UsageLaneResponse> => {
  const response = await api.usage.lane.get({
    fetch: { signal },
  });
  return unwrapEden(response);
};

/**
 * Budget counters move with every chat turn, so this state goes stale
 * almost immediately; hold it just long enough to survive a remount.
 */
const USAGE_LANE_STALE_TIME_MS = 30_000;

export const usageLaneOptions = ({ organizationId }: UsageLaneOptionsInput) =>
  queryOptions({
    queryKey: usageLaneKeys.byOrganization({ organizationId }),
    queryFn: fetchUsageLane,
    staleTime: USAGE_LANE_STALE_TIME_MS,
  });
