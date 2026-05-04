import { roles } from "@stll/permissions";

export type MemberRole = keyof typeof roles;

export const isMemberRole = (role: string): role is MemberRole =>
  Object.hasOwn(roles, role);
