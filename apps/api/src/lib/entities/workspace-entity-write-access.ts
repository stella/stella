import { roles } from "@stll/permissions";

import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";

/**
 * Whether a role reaches a workspace it is not a member of. Firm
 * owners/admins carry the deliberate organization-wide override; everyone
 * else needs a `workspace_members` row.
 */
const WORKSPACE_ACCESS_BY_ROLE = {
  owner: "organization-wide",
  admin: "organization-wide",
  external: "workspace-membership-required",
  member: "workspace-membership-required",
  intern: "workspace-membership-required",
} as const satisfies Record<
  MemberRole,
  "organization-wide" | "workspace-membership-required"
>;

/**
 * Whether a user may still write entity versions in a workspace.
 *
 * Long-lived out-of-band credentials (a desktop edit session token, a PDF
 * signing session token) are minted once and then replayed by a client that
 * cannot see a later role change. Every such request re-evaluates this
 * predicate against the live `member` and `workspace_members` rows, so a
 * revoked role closes the credential on its next use rather than at its TTL.
 */
export const canWriteWorkspaceEntities = ({
  organizationRole,
  workspaceMemberId,
}: {
  organizationRole: string | null;
  workspaceMemberId: string | null;
}) => {
  if (!organizationRole || !isMemberRole(organizationRole)) {
    return false;
  }

  const hasEntityUpdate = roles[organizationRole].authorize({
    entity: ["update"],
  }).success;
  const hasWorkspaceAccess =
    WORKSPACE_ACCESS_BY_ROLE[organizationRole] === "organization-wide" ||
    workspaceMemberId !== null;

  return hasEntityUpdate && hasWorkspaceAccess;
};
