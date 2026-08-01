import type { TranslationKey } from "@/i18n/types";
import type { Role } from "@/lib/auth";

export const managementRoles: readonly Role[] = ["owner", "admin"];

export const ORGANIZATION_MEMBERS_LIMIT = 500;

export const roleTranslationKeys = [
  {
    descriptionKey: "organization.roles.descriptions.owner",
    labelKey: "organization.roles.owner",
    value: "owner",
  },
  {
    descriptionKey: "organization.roles.descriptions.admin",
    labelKey: "organization.roles.admin",
    value: "admin",
  },
  {
    descriptionKey: "organization.roles.descriptions.member",
    labelKey: "organization.roles.member",
    value: "member",
  },
  {
    descriptionKey: "organization.roles.descriptions.intern",
    labelKey: "organization.roles.intern",
    value: "intern",
  },
  {
    descriptionKey: "organization.roles.descriptions.external",
    labelKey: "organization.roles.external",
    value: "external",
  },
] as const satisfies readonly {
  descriptionKey: TranslationKey;
  labelKey: TranslationKey;
  value: Role;
}[];

export const rolePriority = {
  owner: 0,
  admin: 1,
  member: 2,
  intern: 3,
  external: 4,
} as const satisfies Record<Role, number>;
