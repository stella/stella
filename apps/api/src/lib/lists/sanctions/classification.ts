import { EU_MEMBER_STATES } from "@stll/catalogue";
import type { SanctionsIssuer } from "@stll/sanctions";

import type { SanctionsClassification } from "@/api/lib/lists/sanctions/screening-vocabulary";

/**
 * Whether a list binds a firm, from the countries the firm practises in.
 *
 * - The EU and UN lists bind a firm that practises in an EU member state.
 * - A national list binds a firm that practises in the issuing country.
 * - Every other list is informational, and so is every list for a firm that
 *   has not set its practice jurisdictions; the issuer is still reported.
 *
 * Driven by the issuer alone, so a new source needs no entry here.
 */
export const classifySanctionsIssuer = (
  issuer: SanctionsIssuer,
  practiceJurisdictions: readonly string[],
): SanctionsClassification => {
  const codes = practiceJurisdictions.map((code) => code.toUpperCase());
  const binding =
    issuer === "EU" || issuer === "UN"
      ? codes.some((code) => EU_MEMBER_STATES.has(code))
      : codes.includes(issuer);
  return binding ? "binding" : "informational";
};
