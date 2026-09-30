import { hashKey } from "@tanstack/react-query";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import { publicKnowledgeKeys } from "@/features/knowledge/public/public-knowledge-keys";
import { rootKeys, sessionOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { memberKnowledgeKeys } from "@/lib/knowledge/knowledge-cache";
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

type TransitionPolicy = "organization" | "identity";
type TransitionState = {
  visitor: string;
  lastMember: string | undefined;
  pending: Promise<void>;
} & (
  | { phase: "settled" }
  | { phase: "awaiting-frame"; policy: TransitionPolicy }
);
const transitions = new WeakMap<QueryClient, TransitionState>();
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

const hasPrefix = (query: Query, prefix: QueryKey) =>
  prefix.every((part, index) => query.queryKey[index] === part);

const memberIdentity = (visitor: string) =>
  visitor.startsWith("member:")
    ? visitor.slice(0, visitor.lastIndexOf(":"))
    : undefined;

const transitionPolicy = (
  current: TransitionState,
  visitor: string,
): TransitionPolicy =>
  memberIdentity(visitor) !== undefined &&
  (current.lastMember === undefined ||
    current.lastMember === memberIdentity(visitor))
    ? "organization"
    : "identity";

const cleanup = async (
  queryClient: QueryClient,
  predicate: (query: Query) => boolean,
) => {
  const pending = queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
  return await pending;
};

const removedBy = (policy: TransitionPolicy) => (query: Query) => {
  if (hasPrefix(query, publicKnowledgeKeys.all)) {
    return false;
  }
  return policy === "organization"
    ? !hasPrefix(query, rootKeys.session) && !hasPrefix(query, rootKeys.role)
    : !isSessionQuery(query);
};

const observeAuthTransition = async (
  queryClient: QueryClient,
  refreshKnowledge = false,
) => {
  const session: unknown = queryClient.getQueryData(sessionOptions.queryKey);
  if (
    signedInUserId(session) === undefined &&
    authFlowPages.get(queryClient)?.()
  ) {
    // Auth steps retain the working cache for a returning member, but no
    // member Knowledge or outstanding Knowledge read survives a null session.
    await cleanup(queryClient, (query) =>
      hasPrefix(query, memberKnowledgeKeys.all()),
    );
    return;
  }
  const visitor = sessionVisitor(session);
  const current = transitions.get(queryClient);
  if (current === undefined) {
    transitions.set(queryClient, {
      visitor,
      lastMember: memberIdentity(visitor),
      phase: "settled",
      pending: Promise.resolve(),
    });
  } else if (current.visitor !== visitor) {
    const policy =
      current.phase === "awaiting-frame" && current.policy === "identity"
        ? "identity"
        : transitionPolicy(current, visitor);
    const pending = cleanup(queryClient, removedBy(policy));
    transitions.set(queryClient, {
      visitor,
      lastMember: memberIdentity(visitor) ?? current.lastMember,
      phase: "awaiting-frame",
      policy,
      pending,
    });
    await pending;
    return;
  } else {
    await current.pending;
  }
  if (refreshKnowledge) {
    await cleanup(queryClient, (query) =>
      hasPrefix(query, memberKnowledgeKeys.all()),
    );
  }
};

/** Refresh cleanup; completion of a frame change also requires its unmount barrier. */
export const settleAuthTransition = async (queryClient: QueryClient) => {
  await observeAuthTransition(queryClient, true);
};

/** Called after the host has replaced the previous frame with its skeleton. */
export const resetAuthTransition = async (
  queryClient: QueryClient,
  visitor: string,
) => {
  const current = transitions.get(queryClient);
  if (current === undefined) {
    transitions.set(queryClient, {
      visitor,
      lastMember: memberIdentity(visitor),
      phase: "settled",
      pending: Promise.resolve(),
    });
    return;
  }
  if (current.visitor === visitor && current.phase === "settled") {
    await current.pending;
    return;
  }
  const policy =
    current.visitor === visitor && current.phase === "awaiting-frame"
      ? current.policy
      : transitionPolicy(current, visitor);
  // Observers may have rebuilt queries after the early session cleanup.
  // This pass is deliberately not deduplicated against that earlier pass.
  const pending = cleanup(queryClient, removedBy(policy));
  transitions.set(queryClient, {
    visitor,
    lastMember: memberIdentity(visitor) ?? current.lastMember,
    phase: "settled",
    pending,
  });
  await pending;
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
  const initial = queryClient.getQueryState(sessionOptions.queryKey);
  if (initial?.status === "success" && !transitions.has(queryClient)) {
    const visitor = sessionVisitor(initial.data);
    transitions.set(queryClient, {
      visitor,
      lastMember: memberIdentity(visitor),
      phase: "settled",
      pending: Promise.resolve(),
    });
  }
  // Kept once the session ends, so the next sign-in can be told apart.
  let cachedFor = signedInUserId(initial?.data);
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") {
      return;
    }
    if (!isSessionQuery(event.query)) {
      return;
    }
    const session: unknown = event.query.state.data;
    const userId = signedInUserId(session);
    detached(observeAuthTransition(queryClient), "session-cache.transition");
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
