import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const usageEntitlementKeys = {
  all: ["usage", "entitlement"] as const,
};

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

export const usageEntitlementOptions = queryOptions({
  queryKey: usageEntitlementKeys.all,
  queryFn: fetchUsageEntitlement,
});
