import type { ReactNode } from "react";

import { Navigate, useRouterState } from "@tanstack/react-router";

import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";

type KnowledgeMemberOnlyProps = {
  /** While the session is unknown. */
  pending: ReactNode;
  /** The organization's page, for a member of it. */
  children: (organizationId: string) => ReactNode;
};

/**
 * A Knowledge page that is an organization's own (clauses, styles, a skill's
 * editor…). A member sees it; a visitor without an account is sent to the
 * Knowledge landing, which offers the account and returns here, never to a
 * bare sign-in page. Nothing of the page renders before that, and the
 * section's loader reads nothing without a session. The page is keyed by the
 * organization the session names, so a switch remounts it.
 */
export const KnowledgeMemberOnly = ({
  pending,
  children,
}: KnowledgeMemberOnlyProps) => {
  const authStatus = useClientAuthStatus();
  const href = useRouterState({ select: (state) => state.location.href });

  if (authStatus.status === "authenticated") {
    return children(authStatus.user.activeOrganizationId);
  }
  // An unreadable session goes to the landing too: its sign-in is how the
  // session recovers.
  if (
    (authStatus.status === "anonymous" ||
      authStatus.status === "unavailable") &&
    isPublicKnowledgeEnabled()
  ) {
    return <Navigate replace search={{ from: href }} to="/knowledge" />;
  }
  return pending;
};
