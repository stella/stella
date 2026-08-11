import type { QueryClient } from "@tanstack/react-query";

import { getAnalytics } from "@/lib/analytics/provider";
import { sessionOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData } from "@/lib/react-query";

export const loadAuthContext = async (queryClient: QueryClient) => {
  // An unauthenticated visitor is not an error here: `getSession` resolves
  // with no session. A rejection means the session could not be read at all,
  // which this guard still has to report as signed-out; capture it, or a brief
  // API outage looks exactly like everyone signing out at once.
  const sessionData = await ensureRouteQueryData(
    queryClient,
    sessionOptions,
  ).catch((error: unknown) => {
    getAnalytics().captureError(error);
    return null;
  });

  return {
    session: sessionData?.session ?? null,
    user: sessionData?.user ?? null,
  };
};
