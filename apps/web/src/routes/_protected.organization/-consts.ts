import type { getTranslator } from "@/i18n/i18n-store";
import type { Role } from "@/lib/auth";

type Translator = ReturnType<typeof getTranslator>;

export const managementRoles: readonly Role[] = ["owner", "admin"];

export const getRoles = (t: Translator): { label: string; value: Role }[] => [
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
