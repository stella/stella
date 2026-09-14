import { formatFromClauses } from "../format-clauses.js";
import type { RegistryFormatClause } from "../format-clauses.js";
import { BRREG_IDENTIFIER_SPACED_TOKEN } from "./identifier-format.js";

/**
 * The Norwegian party clause. Foretaksregisterloven § 7-2 requires the
 * organisasjonsnummer and the name on business documents; contracts write it
 * inline as "Telenor Norge AS, org.nr 976 967 631, Snarøyveien 30, 1360
 * Fornebu". The "Foretaksregisteret" and "MVA" suffixes are sales-document
 * requirements (bokføringsforskriften § 5-1-2), not party-clause ones, so they
 * are deliberately absent.
 *
 * https://www.telenor.no/vilkar/avtalevilkar/
 */
export const BRREG_DEFAULT_FORMAT_CLAUSES: readonly RegistryFormatClause[] = [
  { template: "**[company name]**", requires: ["company name"] },
  {
    template: `org.nr. [${BRREG_IDENTIFIER_SPACED_TOKEN}]`,
    requires: [BRREG_IDENTIFIER_SPACED_TOKEN],
  },
  { template: "[address]", requires: ["address"] },
];

export const BRREG_DEFAULT_FORMAT: string = formatFromClauses(
  BRREG_DEFAULT_FORMAT_CLAUSES,
);
