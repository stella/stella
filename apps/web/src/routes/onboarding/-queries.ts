import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

type NativeToolDeployAvailabilityKey = readonly [
  "onboarding",
  "native-tool-deploy-availability",
];

export const onboardingKeys = {
  nativeToolDeployAvailability: (): NativeToolDeployAvailabilityKey =>
    ["onboarding", "native-tool-deploy-availability"] as const,
};

export const nativeToolDeployAvailabilityOptions = queryOptions({
  queryKey: onboardingKeys.nativeToolDeployAvailability(),
  queryFn: async ({ signal }) => {
    const response = await api.catalogue["native-tool-deploy-availability"].get(
      {
        fetch: { signal },
      },
    );

    return unwrapEden(response);
  },
  staleTime: ROUTE_QUERY_STALE_TIME_MS,
});
