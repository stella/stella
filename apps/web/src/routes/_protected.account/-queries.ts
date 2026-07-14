import { queryOptions } from "@tanstack/react-query";

import { listAuthSessions } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors/auth";

// Avoid a duplicate fetch when Suspense remounts the observer while keeping
// cross-device session changes visible on the next near-immediate focus/mount.
const SESSION_LIST_DEDUPLICATION_WINDOW_MS = 5_000;

export const sessionsKeys = {
  all: ["sessions"],
};

export const sessionsOptions = queryOptions({
  staleTime: SESSION_LIST_DEDUPLICATION_WINDOW_MS,
  queryKey: sessionsKeys.all,
  queryFn: async () => {
    const result = await listAuthSessions();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data;
  },
});
