import { panic } from "better-result";
import * as v from "valibot";

export const ORGANIZATION_NAME_MAX_LENGTH = 50;
export const ORGANIZATION_SLUG_MAX_LENGTH = 100;
export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9-]+$/u;
export const ORGANIZATION_CREATE_SCOPE = "stella:organization_create";

export const ORGANIZATION_SLUG_RANDOM_BYTES = 10;
const LOWERCASE_BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** The caller supplies fresh CSPRNG bytes; organization names never enter this identifier. */
export const createOrganizationSlug = (randomBytes: Uint8Array) => {
  if (randomBytes.length !== ORGANIZATION_SLUG_RANDOM_BYTES) {
    return panic("Organization slugs require exactly ten random bytes");
  }
  const identifier = Array.from(randomBytes, (byte) =>
    LOWERCASE_BASE32_ALPHABET.charAt(byte % LOWERCASE_BASE32_ALPHABET.length),
  ).join("");
  return `org-${identifier}`;
};

export const organizationCreateOutputSchema = v.strictObject({
  organizationId: v.string(),
  name: v.string(),
  slug: v.string(),
  role: v.literal("owner"),
  nextCall: v.strictObject({
    command: v.literal("stella auth login"),
    instruction: v.string(),
  }),
});
