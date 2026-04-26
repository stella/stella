import type { Role } from "@/lib/auth";

export const managementRoles: readonly Role[] = ["owner", "admin"];

export const getRoles = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // oxlint-disable-next-line typescript-eslint/no-explicit-any -- required for compatibility
  t: (...args: any[]) => string,
): { label: string; value: Role }[] => [
  { label: t("organization.roles.owner"), value: "owner" },
  { label: t("organization.roles.admin"), value: "admin" },
  { label: t("organization.roles.member"), value: "member" },
  { label: t("organization.roles.intern"), value: "intern" },
  { label: t("organization.roles.external"), value: "external" },
];

export const rolePriority = {
  owner: 0,
  admin: 1,
  member: 2,
  intern: 3,
  external: 4,
} as const satisfies Record<Role, number>;
