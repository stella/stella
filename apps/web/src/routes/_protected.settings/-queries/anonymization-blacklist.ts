import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const organizationAnonymizationBlacklistKeys = {
  all: ["organization-settings", "anonymization-blacklist"] as const,
};

export const organizationAnonymizationBlacklistOptions = queryOptions({
  queryKey: organizationAnonymizationBlacklistKeys.all,
  queryFn: async ({ signal }) => {
    const response = await api["organization-settings"][
      "anonymization-blacklist"
    ].get({ fetch: { signal } });

    if (response.error) {
      throw toAPIError(response.error);
    }

    return response.data;
  },
});
