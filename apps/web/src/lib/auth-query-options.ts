import { queryOptions } from "@tanstack/react-query";

import { rootKeys } from "@/lib/account/auth-query-keys.logic";
import { STALE_TIME } from "@/lib/consts";

export { rootKeys };

// Public SSR shortcut readers share the typed key without loading auth modules.
export const sessionOptions = queryOptions({
  retry: false,
  queryKey: rootKeys.session,
  queryFn: async () => {
    const { fetchSession } = await import("@/lib/auth-queries");
    return await fetchSession();
  },
  staleTime: STALE_TIME.FIVE.MINUTES,
});
