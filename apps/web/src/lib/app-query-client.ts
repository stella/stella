import { QueryClient } from "@tanstack/react-query";

import { STALE_TIME } from "@/lib/consts";
import { shouldRetryAPIRequest } from "@/lib/errors/api";

/** The app's query cache, with the defaults every read shares. */
export const createAppQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME.FIVE.MINUTES,
        // Route loaders fetch without retries unless a default says
        // otherwise, so one transient refusal (429, 5xx, a dropped
        // connection) would reach the route's error page. Mutations keep
        // TanStack's no-retry default: a write is never replayed silently.
        retry: shouldRetryAPIRequest,
      },
    },
  });
