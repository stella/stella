import type { BusinessRegistrySlug } from "@stll/api-contract";

/**
 * Countries whose company IDs the sanctions check resolves to a company name
 * through their business register (ARES for CZ, RPO for SK).
 */
export const SANCTIONS_COMPANY_ID_COUNTRIES = ["CZ", "SK"] as const;

export type SanctionsCompanyIdCountry =
  (typeof SANCTIONS_COMPANY_ID_COUNTRIES)[number];

/** The registers a company ID is resolved through, for output schemas. */
export const SANCTIONS_COMPANY_REGISTRIES = [
  "ares",
  "rpo",
] as const satisfies readonly BusinessRegistrySlug[];

export type SanctionsCompanyRegistry =
  (typeof SANCTIONS_COMPANY_REGISTRIES)[number];

/** Which register answers for each country's company IDs. */
export const SANCTIONS_COMPANY_REGISTRY_BY_COUNTRY = {
  CZ: "ares",
  SK: "rpo",
} as const satisfies Record<
  SanctionsCompanyIdCountry,
  SanctionsCompanyRegistry
>;
