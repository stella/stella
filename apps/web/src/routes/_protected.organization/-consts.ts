import type { Role } from "@/lib/auth";

export const managementRoles: Role[] = ["owner", "admin"];

export const getRoles = (
  // biome-ignore lint/suspicious/noExplicitAny: accepts both hook and module translator
  t: (...args: any[]) => string,
): { label: string; value: Role }[] => [
  { label: t("organization.roles.owner"), value: "owner" },
  { label: t("organization.roles.admin"), value: "admin" },
  { label: t("organization.roles.member"), value: "member" },
];

export const rolePriority: Record<Role, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};
