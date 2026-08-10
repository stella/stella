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
  "vies",
] as const;

export type BusinessRegistrySlug = (typeof BUSINESS_REGISTRY_SLUGS)[number];

export const isBusinessRegistrySlug = (
  value: unknown,
): value is BusinessRegistrySlug =>
  typeof value === "string" &&
  BUSINESS_REGISTRY_SLUGS.some((slug) => slug === value);
