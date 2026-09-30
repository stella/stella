import { hashKey } from "@tanstack/react-query";
import type { Query, QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import { rootKeys } from "@/lib/auth-queries";
import { isAuthFlowPathname } from "@/lib/redirect";

/**
 * The client cache holds what one signed-in member read. When a session read
 * reports a different member than the one the cache was filled for, the
 * cache starts over at once, keeping only the session just read, and the
 * page loads again as a new document: right away, or on leaving the sign-in
 * and onboarding pages. The same member signing in again keeps it.
 */

type ReloadDocumentAt = (href: string) => void;

// Clients whose next page loads as a new document, with how to load it.
const freshDocumentPending = new WeakMap<QueryClient, ReloadDocumentAt>();

const SESSION_QUERY_HASH = hashKey(rootKeys.session);

const isSessionQuery = (query: Query) => query.queryHash === SESSION_QUERY_HASH;

/**
 * The signed-in user's id in a cached session, if there is one.
 * Typed `unknown` on purpose: it reads the cached session as data.
 */
export const signedInUserId = (session: unknown): string | undefined =>
  typeof session === "object" &&
  session !== null &&
  "user" in session &&
  typeof session.user === "object" &&
  session.user !== null &&
  "id" in session.user &&
  typeof session.user.id === "string"
    ? session.user.id
    : undefined;

type SessionCacheGuardOptions = {
  /** Whether the page on screen is a sign-in or onboarding step. */
  isAuthFlowPage: () => boolean;
  /** Loads the page on screen again as a new document. */
  reloadDocument: () => void;
  /** Loads `href` as a new document, whatever the page on screen. */
  reloadDocumentAt: ReloadDocumentAt;
};

export const installSessionCacheGuard = (
  queryClient: QueryClient,
  {
    isAuthFlowPage,
    reloadDocument,
    reloadDocumentAt,
  }: SessionCacheGuardOptions,
) => {
  // Kept once the session ends, so the next sign-in can be told apart.
  let cachedFor: string | undefined;
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") {
      return;
    }
    if (event.query.queryHash !== SESSION_QUERY_HASH) {
      return;
    }
    const session: unknown = event.query.state.data;
    const userId = signedInUserId(session);
    if (userId === undefined) {
      return;
    }
    const previous = cachedFor;
    cachedFor = userId;
    if (previous === undefined || previous === userId) {
      return;
    }
    // Removing a query also cancels its read in flight.
    queryClient.removeQueries({ predicate: (query) => !isSessionQuery(query) });
    freshDocumentPending.set(queryClient, reloadDocumentAt);
    if (!isAuthFlowPage()) {
      reloadDocument();
    }
  });
};

/**
 * The next page after a different member signed in loads as a new document,
 * so nothing kept in memory for the previous one (router, stores, providers)
 * carries over. Sign-in and onboarding steps in between stay in the page.
 */
export const requireFreshDocument = async ({
  queryClient,
  location,
}: {
  queryClient: QueryClient;
  location: { pathname: string; hash: string; publicHref: string };
}) => {
  const reloadDocumentAt = freshDocumentPending.get(queryClient);
  if (reloadDocumentAt === undefined || isAuthFlowPathname(location.pathname)) {
    return;
  }
  if (location.hash === "") {
    redirect({ href: location.publicHref, reloadDocument: true, throw: true });
  }
  // Assigning an address that differs only by its fragment scrolls instead of
  // loading, so the page reloads at that address and nothing renders meanwhile.
  reloadDocumentAt(location.publicHref);
  await new Promise<never>(() => {
    // Settles never: the reload replaces the page first.
  });
};
