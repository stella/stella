import type { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";

import { getAnalytics } from "@/lib/analytics/provider";
import { sessionOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData } from "@/lib/react-query";

export const loadAuthContext = async (queryClient: QueryClient) => {
  // An unauthenticated visitor is not an error here: `getSession` resolves
  // with no session. A rejection means the session could not be read at all;
  // preserve that distinction so route recovery handles an outage instead of
  // redirecting an authenticated user to sign-in.
  const sessionPromise = ensureRouteQueryData(queryClient, sessionOptions);
  const sessionResult = await Result.tryPromise({
    try: async () => await sessionPromise,
    catch: (error) => error,
  });
  if (sessionResult.isErr()) {
    getAnalytics().captureError(sessionResult.error);
  }
  // Re-observe the same promise so route recovery receives the original
  // rejection, not a Result unwrap error, without repeating the query.
  const sessionData = await sessionPromise;

  return {
    session: sessionData?.session ?? null,
    user: sessionData?.user ?? null,
  };
};

// The root route dispatches from a mounted async effect, outside the router's
// loader error boundary. Keep its explicit signed-out fallback local; every
// route loader uses loadAuthContext and therefore preserves read failures.
export const loadAuthContextForRootRedirect = async (
  queryClient: QueryClient,
) => {
  const result = await Result.tryPromise(
    async () => await loadAuthContext(queryClient),
  );
  return result.unwrapOr({
    session: null,
    user: null,
  });
};
