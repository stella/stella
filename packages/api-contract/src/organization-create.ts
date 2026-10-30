import { slugify } from "@stll/text-normalize";

export const ORGANIZATION_NAME_MAX_LENGTH = 50;
export const ORGANIZATION_SLUG_MAX_LENGTH = 100;
export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9-]+$/u;
export const ORGANIZATION_CREATE_SCOPE = "stella:organization_create";

/** Shared by onboarding and account-level creation; collision suffixes belong to the server. */
export const createOrganizationSlug = (name: string) =>
  slugify(name, {
    charset: "ascii",
    fallback: "organization",
    maxLength: ORGANIZATION_SLUG_MAX_LENGTH,
    separator: "-",
  });
