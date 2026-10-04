import { roles } from "@stll/permissions";

export type MemberRole = keyof typeof roles;

export const isMemberRole = (role: string): role is MemberRole =>
  Object.hasOwn(roles, role);

/** Organization roles that reach every client matter without a matter
 *  assignment. The stella_authorized_workspaces view repeats this list in SQL;
 *  rls-coverage.test.ts binds the two. */
export const CLIENT_MATTER_ADMIN_ROLES = [
  "owner",
  "admin",
] as const satisfies readonly MemberRole[];
