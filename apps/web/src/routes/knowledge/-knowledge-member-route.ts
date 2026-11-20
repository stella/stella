import type { QueryClient } from "@tanstack/react-query";
import { notFound, redirect } from "@tanstack/react-router";
import { panic, Result } from "better-result";

import { sessionOptions } from "@/lib/auth-query-options";
import type { KnowledgeCataloguePath } from "@/lib/knowledge/knowledge-catalogues";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";

/** What an organization's Knowledge page answers a visitor who is known to
 *  have no session: the section's published catalogue, or nothing. */
export type KnowledgeMemberRouteVisitor =
  { kind: "catalogue"; to: KnowledgeCataloguePath } | { kind: "not-found" };

/**
 * Whether the visitor is known to have no session. On the server, the
 * request's own session is read, so a crawler or a signed-out reader gets the
 * answer as an HTTP response; a read that fails decides nothing. In the
 * browser, only what the cache already holds counts: route entry never waits
 * on a session read here, and the page's own gate settles anything unknown.
 */
const isKnownSignedOut = async (queryClient: QueryClient) => {
  if (import.meta.env.SSR) {
    const { fetchSession } = await import("@/lib/auth-queries");
    const session = await Result.tryPromise(async () => await fetchSession());
    return session.isOk() && session.value === null;
  }
  return queryClient.getQueryData(sessionOptions.queryKey) === null;
};

/**
 * Turns a visitor without an account away from an organization's Knowledge
 * page before any of its code loads: to the section's catalogue with a
 * permanent redirect (the URL once served it to every visitor), or to the
 * not-found page. Behind sign-in the Knowledge layout has already sent such a
 * visitor to sign in, so this only runs while Knowledge is public. Redirect
 * responses are never cached (`apps/web/src/server.ts`), so a member who was
 * once turned away still reaches the page.
 */
export const turnAwaySignedOutVisitor = async ({
  queryClient,
  visitor,
}: {
  queryClient: QueryClient;
  visitor: KnowledgeMemberRouteVisitor;
}): Promise<void> => {
  if (!isPublicKnowledgeEnabled() || !(await isKnownSignedOut(queryClient))) {
    return;
  }
  if (visitor.kind === "not-found") {
    notFound({ throw: true });
    return panic("TanStack Router did not throw a not-found response.");
  }
  redirect({ to: visitor.to, replace: true, statusCode: 301, throw: true });
  return panic("TanStack Router did not throw the catalogue redirect.");
};
