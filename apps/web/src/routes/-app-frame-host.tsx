import { lazy, Suspense, useLayoutEffect, useState } from "react";
import type { ComponentType, ReactElement } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { panic } from "better-result";

import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import type { ClientAuthStatus } from "@/hooks/use-client-auth-status";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { resetAuthTransition } from "@/lib/session-cache-guard";
import {
  frameVisitor,
  selectAppFrame,
  visitorChanged,
} from "@/routes/-app-frame.logic";
import type { AppFrameAudience } from "@/routes/-app-frame.logic";
import { ProtectedPendingSkeleton } from "@/routes/-protected-pending-skeleton";

// The signed-in frame (sidebar, inspector, chat and their registrations) loads
// only once a member is known, so sign-in and pages for visitors never
// evaluate it.
const LazyProtectedAppFrame = lazy(async () => {
  const module = await import("@/routes/-protected-app");
  return { default: module.ProtectedAppFrame };
});

// Only visitors without an account see this shell, so its chunk loads on
// their first Knowledge page and never for members.
const LazyKnowledgePublicFrame = lazy(async () => {
  const module = await import("@/routes/-knowledge-public-frame");
  return { default: module.KnowledgePublicFrame };
});

const ROUTE_ID_SEPARATOR = "\n";

const isAuthenticatedUser = (value: unknown): value is AuthenticatedUser =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "activeOrganizationId" in value &&
  typeof value.activeOrganizationId === "string";

const audienceOf = (authStatus: ClientAuthStatus): AppFrameAudience =>
  authStatus.status === "authenticated" ? "member" : authStatus.status;

/** The signed-in user a matched route's guard put in its context, if any. */
const routeUserOf = (
  matches: readonly { context?: unknown }[],
): AuthenticatedUser | undefined => {
  for (const match of matches.toReversed()) {
    const context = match.context;
    const user: unknown =
      typeof context === "object" && context !== null && "user" in context
        ? context.user
        : undefined;
    if (isAuthenticatedUser(user)) {
      return user;
    }
  }
  return undefined;
};

/**
 * Renders the frame the matched routes call for around them. The frame lives
 * here, above the routes, so moving between signed-in pages keeps it mounted:
 * every member frame renders at this one position, keyed by organization and
 * user, so a page change never remounts it and an organization switch always
 * does.
 */
type AppFrameHostProps = {
  children: ReactElement;
  frames?: {
    member: ComponentType<{ children: ReactElement; user: AuthenticatedUser }>;
    public: ComponentType<{ children: ReactElement }>;
  };
};

export const AppFrameHost = ({ children, frames }: AppFrameHostProps) => {
  const MemberFrame = frames?.member ?? LazyProtectedAppFrame;
  const PublicFrame = frames?.public ?? LazyKnowledgePublicFrame;
  const routeIdKey = useRouterState({
    select: (state) =>
      state.matches.map((match) => match.routeId).join(ROUTE_ID_SEPARATOR),
  });
  const routeUser = useRouterState({
    select: (state) => routeUserOf(state.matches),
  });
  const routeIds = routeIdKey.split(ROUTE_ID_SEPARATOR);
  const publicKnowledge = isPublicKnowledgeEnabled();
  const needsAudience =
    selectAppFrame({
      routeIds,
      hasRouteUser: routeUser !== undefined,
      publicKnowledge,
    }) === "unresolved";
  // Asked for only where the frame depends on it: other pages keep exactly
  // the requests they make today.
  const authStatus = useClientAuthStatus({ enabled: needsAudience });
  const audience = needsAudience ? audienceOf(authStatus) : undefined;
  const frame = selectAppFrame({
    routeIds,
    hasRouteUser: routeUser !== undefined,
    publicKnowledge,
    audience,
  });
  const memberUser =
    routeUser ??
    (audience === "member" && authStatus.status === "authenticated"
      ? authStatus.user
      : undefined);

  // When the page moves on to another visitor (sign-out, another
  // organization, an expired session), nothing read for the previous one may
  // render again: neither frame shows until the cache holds only what says who
  // is visiting, reads in flight included. The next frame then mounts clean.
  const queryClient = useQueryClient();
  const visitor = frameVisitor(
    frame,
    memberUser === undefined
      ? undefined
      : {
          userId: memberUser.id,
          organizationId: memberUser.activeOrganizationId,
        },
  );
  const [shownVisitor, setShownVisitor] = useState<string | null>(null);
  const resetting = visitorChanged({ publicKnowledge, shownVisitor, visitor });
  // The first visitor the frame is shown to is recorded as it renders.
  if (publicKnowledge && shownVisitor === null && visitor !== null) {
    setShownVisitor(visitor);
  }
  useLayoutEffect(() => {
    if (!publicKnowledge || visitor === null) {
      return undefined;
    }
    const superseded = new AbortController();
    detached(
      (async () => {
        await resetAuthTransition(queryClient, visitor);
        if (!superseded.signal.aborted) {
          setShownVisitor(visitor);
        }
      })(),
      "app-frame.reset-visitor",
    );
    return () => {
      superseded.abort();
    };
  }, [queryClient, publicKnowledge, visitor]);

  if (resetting) {
    return <ProtectedPendingSkeleton />;
  }

  switch (frame) {
    case "member":
      return memberUser === undefined ? (
        <ProtectedPendingSkeleton />
      ) : (
        <Suspense fallback={<ProtectedPendingSkeleton />}>
          <MemberFrame
            key={`${memberUser.activeOrganizationId}:${memberUser.id}`}
            user={memberUser}
          >
            {children}
          </MemberFrame>
        </Suspense>
      );
    case "public":
      return (
        <Suspense fallback={<ProtectedPendingSkeleton />}>
          <PublicFrame>{children}</PublicFrame>
        </Suspense>
      );
    case "checking":
    case "unresolved":
      // Until the visitor is known, neither frame (nor anything it would
      // fetch) mounts.
      return <ProtectedPendingSkeleton />;
    case "neutral":
      // A page the same for every visitor shows inside the skeleton, so it
      // is there in the server render before either frame mounts.
      return <ProtectedPendingSkeleton content={children} />;
    case "none":
      return children;
    default: {
      frame satisfies never;
      return panic(`Unhandled frame: ${String(frame)}`);
    }
  }
};
