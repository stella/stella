import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { panic, Result } from "better-result";

import { PROFESSIONAL_USE_STATUS } from "@stll/api-contract/professional-use";

import { getAnalytics } from "@/lib/analytics/provider";
import { professionalUseOptions, sessionOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import { returnPathOf } from "@/lib/redirect";

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
    getAnalytics().captureError(sessionResult.error, {
      fingerprintKey: "loadAuthContext:failure",
      scope: { type: "handler", handlerId: "loadAuthContext:failure" },
    });
  }
  // Re-observe the same promise so route recovery receives the original
  // rejection, not a Result unwrap error, without repeating the query.
  const sessionData = await sessionPromise;

  return {
    session: sessionData?.session ?? null,
    user: sessionData?.user ?? null,
  };
};

type AuthContext = Awaited<ReturnType<typeof loadAuthContext>>;

type ProfessionalUseGuardArgs = {
  authContext?: AuthContext;
  queryClient: QueryClient;
  location: { pathname: string; searchStr: string };
};

/**
 * The single interactive-route boundary for professional-use acceptance.
 * Public and protected routes both pass through it, so a signed-in account
 * cannot remain on a page whose member actions the API will refuse.
 */
export const requireProfessionalUseForSignedInRoute = async ({
  authContext: suppliedAuthContext,
  queryClient,
  location,
}: ProfessionalUseGuardArgs): Promise<AuthContext> => {
  const authContext =
    suppliedAuthContext ?? (await loadAuthContext(queryClient));
  if (!authContext.session || location.pathname === "/auth/professional-use") {
    return authContext;
  }

  const professionalUse = await ensureRouteQueryData(
    queryClient,
    professionalUseOptions(authContext.session.userId),
  );
  switch (professionalUse.status) {
    case PROFESSIONAL_USE_STATUS.accepted:
      return authContext;
    case PROFESSIONAL_USE_STATUS.required:
      redirect({
        to: "/auth/professional-use",
        search: { redirectTo: returnPathOf(location) },
        replace: true,
        throw: true,
      });
      return panic(
        "TanStack Router did not throw the professional-use redirect.",
      );
    default:
      professionalUse satisfies never;
      return panic("Unhandled professional-use state");
  }
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
