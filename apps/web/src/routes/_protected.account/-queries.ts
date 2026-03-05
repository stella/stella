import { queryOptions } from "@tanstack/react-query";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";

export const sessionsKeys = {
  all: ["sessions"],
};

export const sessionsOptions = queryOptions({
  staleTime: 0,
  queryKey: sessionsKeys.all,
  queryFn: async () => {
    const result = await authClient.listSessions();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data;
  },
});
