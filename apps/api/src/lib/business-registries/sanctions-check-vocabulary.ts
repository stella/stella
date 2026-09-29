/**
 * Countries whose company IDs the sanctions check resolves to a company name
 * through their business register (ARES for CZ, RPO for SK).
 */
export const SANCTIONS_COMPANY_ID_COUNTRIES = ["CZ", "SK"] as const;

export type SanctionsCompanyIdCountry =
  (typeof SANCTIONS_COMPANY_ID_COUNTRIES)[number];
