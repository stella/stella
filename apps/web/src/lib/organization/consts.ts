import type { TranslationKey } from "@/i18n/types";
import type { Role } from "@/lib/auth-client";

export const roleTranslationKeys = {
  owner: {
    descriptionKey: "organization.roles.descriptions.owner",
    labelKey: "organization.roles.owner",
  },
  admin: {
    descriptionKey: "organization.roles.descriptions.admin",
    labelKey: "organization.roles.admin",
  },
  member: {
    descriptionKey: "organization.roles.descriptions.member",
    labelKey: "organization.roles.member",
  },
  intern: {
    descriptionKey: "organization.roles.descriptions.intern",
    labelKey: "organization.roles.intern",
  },
  external: {
    descriptionKey: "organization.roles.descriptions.external",
    labelKey: "organization.roles.external",
  },
} as const satisfies Record<
  Role,
  {
    descriptionKey: TranslationKey;
    labelKey: TranslationKey;
  }
>;
