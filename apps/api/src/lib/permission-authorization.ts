import type { PermissionInput } from "@stll/permissions";
import { roles } from "@stll/permissions";

import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";

export type AuthorizedMemberRole = {
  role: MemberRole;
};

type MemberRoleContext = {
  memberRole: unknown;
};

type RoleContainer = {
  role: unknown;
};

const hasOwnMemberRole = (ctx: object): ctx is MemberRoleContext =>
  Object.hasOwn(ctx, "memberRole");

const hasOwnRole = (memberRole: object): memberRole is RoleContainer =>
  Object.hasOwn(memberRole, "role");

export const readAuthorizedMemberRole = (
  ctx: object,
): AuthorizedMemberRole | null => {
  if (!hasOwnMemberRole(ctx)) {
    return null;
  }

  const { memberRole } = ctx;
  if (
    typeof memberRole !== "object" ||
    memberRole === null ||
    !hasOwnRole(memberRole)
  ) {
    return null;
  }

  const { role } = memberRole;
  if (typeof role !== "string" || !isMemberRole(role)) {
    return null;
  }

  return { role };
};

export const hasMemberPermission = (
  memberRole: AuthorizedMemberRole,
  permissions: PermissionInput,
): boolean => roles[memberRole.role].authorize(permissions).success;
