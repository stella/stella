export const BUSINESS_REGISTRY_SLUGS = [
  "ares",
  "brreg",
  "companies-house",
  "denue",
  "edgar",
  "gcis",
  "krs",
  "orsr",
  "prh",
  "recherche-entreprises",
  "rpo",
  "vies",
] as const;

export type BusinessRegistrySlug = (typeof BUSINESS_REGISTRY_SLUGS)[number];

/**
 * How much of the record a canonical-ID lookup reads. `full` also reads what
 * a register keeps beyond the current record (ORSR history, filed documents,
 * and related persons; RPO superseded records) at the cost of more requests.
 */
export const BUSINESS_REGISTRY_LOOKUP_DETAILS = ["standard", "full"] as const;

export type BusinessRegistryLookupDetail =
  (typeof BUSINESS_REGISTRY_LOOKUP_DETAILS)[number];

export const BUSINESS_REGISTRY_CONFIGURATION = {
  ares: "none",
  brreg: "none",
  "companies-house": "api-key",
  denue: "api-key",
  edgar: "user-agent",
  gcis: "none",
  krs: "none",
  orsr: "none",
  prh: "none",
  "recherche-entreprises": "none",
  rpo: "none",
  vies: "none",
} as const satisfies Record<
  BusinessRegistrySlug,
  "none" | "api-key" | "user-agent"
>;

export type BusinessRegistryCredentialSlug = {
  [
    Slug in BusinessRegistrySlug
  ]: (typeof BUSINESS_REGISTRY_CONFIGURATION)[Slug] extends "none"
    ? never
    : Slug;
}[BusinessRegistrySlug];

export const isBusinessRegistryCredentialSlug = (
  slug: BusinessRegistrySlug,
): slug is BusinessRegistryCredentialSlug =>
  BUSINESS_REGISTRY_CONFIGURATION[slug] !== "none";

export const BUSINESS_REGISTRY_CREDENTIAL_SLUGS = [
  "companies-house",
  "denue",
  "edgar",
] as const satisfies readonly BusinessRegistryCredentialSlug[];

true satisfies Exclude<
  BusinessRegistryCredentialSlug,
  (typeof BUSINESS_REGISTRY_CREDENTIAL_SLUGS)[number]
> extends never
  ? true
  : never;

export const isBusinessRegistrySlug = (
  value: unknown,
): value is BusinessRegistrySlug =>
  typeof value === "string" &&
  BUSINESS_REGISTRY_SLUGS.some((slug) => slug === value);
