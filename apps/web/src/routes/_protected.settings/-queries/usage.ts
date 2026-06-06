import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
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

/** Returns the org's active usage entitlement state, or null when absent. */
export type UsageEntitlementResponse = NonNullable<
  Awaited<ReturnType<typeof api.usage.entitlement.get>>["data"]
> | null;

export type UsageEntitlement = NonNullable<UsageEntitlementResponse>;

const fetchUsageEntitlement = async ({
  signal,
}: {
  signal: AbortSignal;
}): Promise<UsageEntitlementResponse> => {
  const response = await api.usage.entitlement.get({
    fetch: { signal },
  });
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data;
};

export const usageEntitlementOptions = ({
  organizationId,
}: UsageEntitlementOptionsInput) =>
  queryOptions({
    queryKey: usageEntitlementKeys.byOrganization({ organizationId }),
    queryFn: fetchUsageEntitlement,
  });
