import { hashKey } from "@tanstack/react-query";
import type { Query, QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import { rootKeys, sessionOptions } from "@/lib/auth-query-options";
import { detached } from "@/lib/detached";
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

const isSessionQuery = (query: Query) =>
  query.queryHash === hashKey(rootKeys.session);

const transitions = new WeakMap<
  QueryClient,
  {
    visitor: string;
    pending: Promise<void>;
  }
>();
const authFlowPages = new WeakMap<QueryClient, () => boolean>();

const sessionVisitor = (session: unknown): string => {
  const userId = signedInUserId(session);
  if (userId === undefined) {
    return "anonymous";
  }
  const organizationId =
    typeof session === "object" &&
    session !== null &&
    "session" in session &&
    typeof session.session === "object" &&
    session.session !== null &&
    "activeOrganizationId" in session.session &&
    typeof session.session.activeOrganizationId === "string"
      ? session.session.activeOrganizationId
      : "";
  return `member:${userId}:${organizationId}`;
};

export const resetAuthTransition = async (
  queryClient: QueryClient,
  visitor: string,
) => {
  const current = transitions.get(queryClient);
  if (current?.visitor === visitor) {
    return await current.pending;
  }
  if (current === undefined) {
    const pending = Promise.resolve();
    transitions.set(queryClient, { visitor, pending });
    return await pending;
  }
  const predicate = (query: Query) => !isSessionQuery(query);
  const pending = queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
  transitions.set(queryClient, { visitor, pending });
  return await pending;
};

export const settleAuthTransition = async (queryClient: QueryClient) => {
  const session: unknown = queryClient.getQueryData(sessionOptions.queryKey);
  if (
    signedInUserId(session) === undefined &&
    authFlowPages.get(queryClient)?.()
  ) {
    return;
  }
  await resetAuthTransition(queryClient, sessionVisitor(session));
};

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
  authFlowPages.set(queryClient, isAuthFlowPage);
  // Kept once the session ends, so the next sign-in can be told apart.
  let cachedFor: string | undefined;
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") {
      return;
    }
    if (!isSessionQuery(event.query)) {
      return;
    }
    const session: unknown = event.query.state.data;
    const userId = signedInUserId(session);
    detached(settleAuthTransition(queryClient), "session-cache.transition");
    if (userId === undefined) {
      return;
    }
    const previous = cachedFor;
    cachedFor = userId;
    if (previous === undefined || previous === userId) {
      return;
    }
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
