import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

const myTasksKeys = {
  all: ["my-tasks"],
};

export const myTasksOptions = queryOptions({
  queryKey: myTasksKeys.all,
  queryFn: async ({ signal }) => {
    const response = await api["my-tasks"].get({
      fetch: { signal },
    });

    if (response.error) {
      throw toAPIError(response.error);
    }

    return response.data;
  },
});
