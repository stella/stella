import type { getTranslator } from "@/i18n/i18n-store";
import type { Role } from "@/lib/auth";

type Translator = ReturnType<typeof getTranslator>;

export const managementRoles: readonly Role[] = ["owner", "admin"];

export const getRoles = (
  t: Translator,
): { label: string; value: Role; description: string }[] => [
  {
    label: t("organization.roles.owner"),
    value: "owner",
    description: t("organization.roles.descriptions.owner"),
  },
  {
    label: t("organization.roles.admin"),
    value: "admin",
    description: t("organization.roles.descriptions.admin"),
  },
  {
    label: t("organization.roles.member"),
    value: "member",
    description: t("organization.roles.descriptions.member"),
  },
  {
    label: t("organization.roles.intern"),
    value: "intern",
    description: t("organization.roles.descriptions.intern"),
  },
  {
    label: t("organization.roles.external"),
    value: "external",
    description: t("organization.roles.descriptions.external"),
  },
];

export const rolePriority = {
  owner: 0,
  admin: 1,
  member: 2,
  intern: 3,
  external: 4,
} as const satisfies Record<Role, number>;
