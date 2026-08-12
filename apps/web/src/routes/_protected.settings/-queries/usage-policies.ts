import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const usagePoliciesKeys = {
  all: ["settings", "usage", "policies"] as const,
};

type ListUsagePoliciesFn = (typeof api.usage.policies)["get"];

/** The deployment's publicly visible usage-policy catalog. */
export type UsagePoliciesResponse = NonNullable<
  Awaited<ReturnType<ListUsagePoliciesFn>>["data"]
>;

export type UsagePolicyEntry = UsagePoliciesResponse["policies"][number];

const fetchUsagePolicies = async ({
  signal,
}: {
  signal: AbortSignal;
}): Promise<UsagePoliciesResponse> => {
  const response = await api.usage.policies.get({ fetch: { signal } });
  return unwrapEden(response);
};

// The catalog is deployment-scoped (operator-seeded), not tenant data,
// so this stays a flat `queryOptions` value rather than a keyed factory.
export const usagePoliciesOptions = queryOptions({
  queryKey: usagePoliciesKeys.all,
  staleTime: ROUTE_QUERY_STALE_TIME_MS,
  queryFn: fetchUsagePolicies,
});
