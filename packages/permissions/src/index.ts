import { createAccessControl } from "better-auth/plugins/access";

import type { OrganizationRoleName } from "@stll/auth-model";
import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import { ROLE_GRANTS, statements } from "./role-grants";

export type { PermissionInput } from "./role-grants";
export { roleAllows, statements } from "./role-grants";

export const ac = createAccessControl(statements);

/**
 * The roles that hold `managementStellaGrants`: they administer the firm's
 * shared configuration and content (team skills, rates, firm memory). Code
 * that gates on "admin or owner" reads this list, and so does row-level
 * security, so the role set lives in one place.
 */
export const ORGANIZATION_MANAGEMENT_ROLES = [
  "owner",
  "admin",
] as const satisfies readonly OrganizationRoleName[];

type OrganizationManagementRole =
  (typeof ORGANIZATION_MANAGEMENT_ROLES)[number];

export const isOrganizationManagementRole = (
  role: string,
): role is OrganizationManagementRole =>
  ORGANIZATION_MANAGEMENT_ROLES.some(
    (managementRole) => managementRole === role,
  );

/**
 * The roles that reach every client matter without a matter assignment. The
 * stella_authorized_workspaces view repeats this list in SQL; the API's RLS
 * coverage test binds the two.
 */
export const CLIENT_MATTER_ADMIN_ROLES = [
  "owner",
  "admin",
] as const satisfies readonly OrganizationRoleName[];

export const roles = {
  owner: ac.newRole(ROLE_GRANTS.owner),
  admin: ac.newRole(ROLE_GRANTS.admin),
  member: ac.newRole(ROLE_GRANTS.member),
  intern: ac.newRole(ROLE_GRANTS.intern),
  external: ac.newRole(ROLE_GRANTS.external),
} satisfies Record<OrganizationRoleName, unknown>;

/** Single product roles an actor can assign through membership management. */
export const assignableRoles = (
  actorRole: keyof typeof roles,
): readonly OrganizationRoleName[] => {
  if (!isOrganizationManagementRole(actorRole)) {
    return [];
  }
  return ORGANIZATION_ROLE_NAMES.filter(
    (role) => role !== "owner" || actorRole === "owner",
  );
};
