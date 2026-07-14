import { queryOptions } from "@tanstack/react-query";

import { listAuthSessions } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors/auth";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const sessionsKeys = {
  all: ["sessions"],
};

export const sessionsOptions = queryOptions({
  staleTime: ROUTE_QUERY_STALE_TIME_MS,
  queryKey: sessionsKeys.all,
  queryFn: async () => {
    const result = await listAuthSessions();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data;
  },
});
