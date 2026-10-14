import type { MatterVisibility } from "@stll/api-contract";
import { roles } from "@stll/permissions";

import { isMemberRole } from "@/api/lib/member-roles";
import { reachesMatterWithoutMembership } from "@/api/lib/workspaces/visibility";

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
  workspaceVisibility,
}: {
  organizationRole: string | null;
  workspaceMemberId: string | null;
  workspaceVisibility: MatterVisibility;
}) => {
  if (!organizationRole || !isMemberRole(organizationRole)) {
    return false;
  }

  const hasEntityUpdate = roles[organizationRole].authorize({
    entity: ["update"],
  }).success;
  // Assignment, or the matter's visibility reaching the role without one
  // (owners/admins on admins_and_assigned, every internal role on
  // all_members). Re-read on every use, so narrowing a matter closes the
  // credential of anyone it no longer reaches.
  const hasWorkspaceAccess =
    workspaceMemberId !== null ||
    reachesMatterWithoutMembership({
      role: organizationRole,
      visibility: workspaceVisibility,
    });

  return hasEntityUpdate && hasWorkspaceAccess;
};
