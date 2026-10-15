import { CLIENT_MATTER_ADMIN_ROLES, roles } from "@stll/permissions";

import { isMemberRole } from "@/api/lib/member-roles";

/**
 * Whether a user may still write entity versions in a workspace.
 *
 * Long-lived out-of-band credentials (a desktop edit session token, a PDF
 * signing session token) are minted once and then replayed by a client that
 * cannot see a later role change. Every such request re-evaluates this
 * predicate against the live `member`, `workspace_members` and `workspaces`
 * rows, so a revoked role closes the credential on its next use rather than
 * at its TTL.
 *
 * Matter reach follows the stella_authorized_workspaces view: a
 * `workspace_members` row, or a `CLIENT_MATTER_ADMIN_ROLES` role on a client
 * matter (`client_id` set). A matter without a client is reached through
 * membership only.
 */
export const canWriteWorkspaceEntities = ({
  organizationRole,
  workspaceClientId,
  workspaceMemberId,
}: {
  organizationRole: string | null;
  workspaceClientId: string | null;
  workspaceMemberId: string | null;
}) => {
  if (!organizationRole || !isMemberRole(organizationRole)) {
    return false;
  }

  const hasEntityUpdate = roles[organizationRole].authorize({
    entity: ["update"],
  }).success;
  const hasWorkspaceAccess =
    workspaceMemberId !== null ||
    (workspaceClientId !== null &&
      CLIENT_MATTER_ADMIN_ROLES.some((role) => role === organizationRole));

  return hasEntityUpdate && hasWorkspaceAccess;
};
