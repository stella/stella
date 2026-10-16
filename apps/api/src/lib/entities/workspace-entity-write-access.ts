import { roles } from "@stll/permissions";

import { isMemberRole } from "@/api/lib/member-roles";

/**
 * Whether a user may still write entity versions in a workspace.
 *
 * Long-lived out-of-band credentials (a desktop edit session token, a PDF
 * signing session token) are minted once and then replayed by a client that
 * cannot see a later role change. Every such request re-evaluates this
 * predicate against the live rows, so a revoked role closes the credential on
 * its next use rather than at its TTL.
 *
 * Matter reach is the database rule's answer (`memberReachesMatterSql` from
 * the authorized-workspace owner module), selected next to the caller's rows;
 * this predicate adds only the organization role's entity update permission.
 */
export const canWriteWorkspaceEntities = ({
  organizationRole,
  reachesMatter,
}: {
  organizationRole: string | null;
  reachesMatter: boolean;
}) =>
  reachesMatter &&
  organizationRole !== null &&
  isMemberRole(organizationRole) &&
  roles[organizationRole].authorize({ entity: ["update"] }).success;
