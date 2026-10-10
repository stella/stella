import { panic } from "better-result";

import type { ClientAuthStatus } from "@/hooks/use-client-auth-status";
import { APIError } from "@/lib/errors/api";
import { AuthClientError } from "@/lib/errors/auth";
import { isStaleDeploymentLoadError } from "@/lib/preload-error-recovery";
import { CriticalQueryTimeoutError } from "@/lib/react-query";

/** Network errors that indicate a transient connectivity
 *  issue (API down, DNS failure, etc.).
 *  Message varies by browser engine:
 *  - Chromium: "Failed to fetch"
 *  - Firefox:  "NetworkError when attempting to fetch resource."
 *  - Safari:   "Load failed" */
const NETWORK_ERROR_MESSAGES = Object.freeze([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
]);

export type RouteErrorRecovery =
  | { type: "reload-page" }
  | { type: "retry-route" };

export const resolveRouteErrorRecovery = (
  error: unknown,
): RouteErrorRecovery =>
  isStaleDeploymentLoadError(error)
    ? { type: "reload-page" }
    : { type: "retry-route" };

type RecoverRouteErrorOptions = {
  error: unknown;
  recordRetryStarted: (recovery: RouteErrorRecovery["type"]) => Promise<void>;
  reloadPage: () => void;
  retryRoute: () => void;
};

export const recoverRouteError = async ({
  error,
  recordRetryStarted,
  reloadPage,
  retryRoute,
}: RecoverRouteErrorOptions): Promise<void> => {
  const recovery = resolveRouteErrorRecovery(error);
  const retryDispatch = recordRetryStarted(recovery.type);
  switch (recovery.type) {
    case "reload-page": {
      await retryDispatch;
      reloadPage();
      return;
    }
    case "retry-route": {
      retryRoute();
      await retryDispatch;
      return;
    }
    default: {
      recovery satisfies never;
      return panic(`Unhandled recovery: ${String(recovery)}`);
    }
  }
};

export type RouteErrorSupport =
  | { type: "report" }
  | { type: "administrator" }
  | { type: "none" };

type ResolveRouteErrorSupportOptions = {
  deployment: "hosted" | "selfHosted";
  session: ClientAuthStatus["status"];
};

/** Reporting posts to the authenticated feedback route, so it is offered only
 *  to a signed-in session. A session still being checked counts as signed out:
 *  the screen must resolve without waiting on a query that may itself be the
 *  thing that failed. */
export const resolveRouteErrorSupport = ({
  deployment,
  session,
}: ResolveRouteErrorSupportOptions): RouteErrorSupport => {
  if (session === "authenticated") {
    return { type: "report" };
  }

  if (deployment === "selfHosted") {
    return { type: "administrator" };
  }

  return { type: "none" };
};

export const isNetworkError = (error: unknown): boolean => {
  if (CriticalQueryTimeoutError.is(error)) {
    return true;
  }
  if (APIError.is(error) || AuthClientError.is(error)) {
    return error.status === 0;
  }
  return (
    error instanceof TypeError && NETWORK_ERROR_MESSAGES.includes(error.message)
  );
};
