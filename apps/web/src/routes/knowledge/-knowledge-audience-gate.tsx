import { Fragment } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";

import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { isPublicKnowledgeEnabled } from "@/lib/public-knowledge-launch";

type KnowledgeAudienceGateProps = {
  /** While the session is unknown: a skeleton, no data. */
  checking: ReactNode;
  /** A visitor without an account: the catalogue container. */
  anonymous: () => ReactNode;
  /** A member: the organization's container, lazily loaded by the route. */
  member: (organizationId: string) => ReactNode;
};

/**
 * Picks what a Knowledge section shows from the session, and only once the
 * session is known. Nothing is selected while it is being read, a visitor
 * without an account never reaches the member branch, and a member's branch
 * remounts when the organization changes, so nothing from the previous one
 * stays on screen.
 */
export const KnowledgeAudienceGate = ({
  checking,
  anonymous,
  member,
}: KnowledgeAudienceGateProps) => {
  const authStatus = useClientAuthStatus();

  switch (authStatus.status) {
    case "checking":
      return checking;
    case "anonymous":
      // Behind sign-in the route guard has already sent visitors away; a
      // session read that fails here must not open the catalogue instead.
      return isPublicKnowledgeEnabled() ? anonymous() : checking;
    case "authenticated": {
      const organizationId = authStatus.user.activeOrganizationId;
      return <Fragment key={organizationId}>{member(organizationId)}</Fragment>;
    }
    default: {
      authStatus satisfies never;
      return panic(`Unhandled session state: ${String(authStatus)}`);
    }
  }
};
