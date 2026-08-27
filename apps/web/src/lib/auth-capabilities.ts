import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { APIError } from "@/lib/errors/api";

/**
 * What the deployment's auth configuration offers: which sign-in surfaces are
 * available, and whether it can deliver transactional email. Shared so the
 * sign-in panel and account settings read one query rather than two copies of
 * the same request.
 */
export const authCapabilitiesOptions = queryOptions({
  queryKey: ["auth-capabilities"],
  queryFn: async ({ signal }) => {
    const response = await api.auth.capabilities.get({ fetch: { signal } });

    if (response.error) {
      throw new APIError({
        status: 500,
        message: "Failed to load auth capabilities",
      });
    }

    return response.data;
  },
});
