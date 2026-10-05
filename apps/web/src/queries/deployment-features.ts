import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapEden } from "@/lib/errors/api";

/** The deployment features this server serves; the same for every caller. */
export const deploymentFeaturesOptions = queryOptions({
  queryKey: ["deployment-features"] as const,
  queryFn: async ({ signal }) => {
    const response = await api["organization-settings"][
      "deployment-features"
    ].get({ fetch: { signal } });

    return unwrapEden(response);
  },
  staleTime: STALE_TIME.FIVE.MINUTES,
});
