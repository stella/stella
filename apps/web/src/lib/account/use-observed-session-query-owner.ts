import { useSyncExternalStore } from "react";

import { hashKey } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { observeAuthQueryOwner } from "@/lib/account/auth-query-owner";
import { sessionOptions } from "@/lib/auth-query-options";

/** Subscription identity only. Request authority still needs a successful session. */
export const useObservedSessionQueryOwner = (queryClient: QueryClient) =>
  useSyncExternalStore(
    (notify) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === hashKey(sessionOptions.queryKey)) {
          notify();
        }
      }),
    () => observeAuthQueryOwner(queryClient),
    () => undefined,
  );
