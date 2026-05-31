import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

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

    if (response.error) {
      throw toAPIError(response.error);
    }

    return response.data;
  },
});
