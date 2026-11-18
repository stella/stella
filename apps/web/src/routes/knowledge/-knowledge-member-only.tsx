import { Fragment } from "react";
import type { ReactElement } from "react";

import { Navigate, useRouterState } from "@tanstack/react-router";
import { panic } from "better-result";

import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import type { KnowledgeCataloguePath } from "@/lib/knowledge/knowledge-catalogues";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";

/**
 * What a visitor without an account gets on an organization's page: the
 * Knowledge landing, which offers the account and returns here; the
 * section's published catalogue; or a page of the section's own.
 */
export type KnowledgeVisitorFallback =
  | { kind: "landing" }
  | { kind: "catalogue"; to: KnowledgeCataloguePath }
  | { kind: "page"; page: ReactElement };

const LANDING: KnowledgeVisitorFallback = { kind: "landing" };

type KnowledgeMemberOnlyProps = {
  /** While the session is unknown. */
  pending: ReactElement | null;
  /** Where a visitor without an account goes; the landing by default. */
  visitor?: KnowledgeVisitorFallback | undefined;
  /** The organization's page, for a member of it. */
  children: (organizationId: string) => ReactElement | null;
};

/**
 * A Knowledge page that is an organization's own (templates, clauses, a
 * skill's editor…). A member sees it; a visitor without an account gets the
 * page's fallback, never a bare sign-in page. Nothing of the page renders
 * before that, and the section's loader reads nothing without a session. The
 * page is keyed by the organization the session names, so a switch remounts
 * it.
 */
export const KnowledgeMemberOnly = ({
  pending,
  visitor = LANDING,
  children,
}: KnowledgeMemberOnlyProps) => {
  const authStatus = useClientAuthStatus();
  const href = useRouterState({ select: (state) => state.location.href });

  if (authStatus.status === "authenticated") {
    const organizationId = authStatus.user.activeOrganizationId;
    return <Fragment key={organizationId}>{children(organizationId)}</Fragment>;
  }
  // An unreadable session is turned away too: the fallback's sign-in is how
  // the session recovers.
  if (
    (authStatus.status === "anonymous" ||
      authStatus.status === "unavailable") &&
    isPublicKnowledgeEnabled()
  ) {
    switch (visitor.kind) {
      case "landing":
        return <Navigate replace search={{ from: href }} to="/knowledge" />;
      case "catalogue":
        return <Navigate replace to={visitor.to} />;
      case "page":
        return visitor.page;
      default: {
        visitor satisfies never;
        return panic(`Unhandled visitor fallback: ${String(visitor)}`);
      }
    }
  }
  return pending;
};
