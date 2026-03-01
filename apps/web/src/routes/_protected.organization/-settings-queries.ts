import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const organizationSettingsKeys = {
  all: ["organization-settings"],
};

export const organizationSettingsOptions = queryOptions({
  queryKey: organizationSettingsKeys.all,
  queryFn: async ({ signal }) => {
    const response = await api["organization-settings"].get({
      fetch: { signal },
    });

    if (response.error) {
      throw toAPIError(response.error);
    }

    return response.data;
  },
});
