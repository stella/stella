import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const aiConfigKeys = {
  all: ["organization-ai-config"],
  availability: ["organization-ai-availability"],
};

export const aiConfigOptions = queryOptions({
  queryKey: aiConfigKeys.all,
  queryFn: async ({ signal }) => {
    const response = await api["organization-settings"]["ai-config"].get({
      fetch: { signal },
    });

    if (response.error) {
      throw toAPIError(response.error);
    }

    return response.data;
  },
});

/**
 * AI availability for any org member, regardless of admin
 * permissions on the full AI config. Returns just the booleans
 * needed by the gate; ai-config is admin-only.
 */
export const aiAvailabilityOptions = queryOptions({
  queryKey: aiConfigKeys.availability,
  queryFn: async ({ signal }) => {
    const response = await api["organization-settings"]["ai-availability"].get({
      fetch: { signal },
    });

    if (response.error) {
      throw toAPIError(response.error);
    }

    return response.data;
  },
});
