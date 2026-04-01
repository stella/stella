import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const aiConfigKeys = {
  all: ["organization-ai-config"],
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
