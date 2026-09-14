import { formatFromClauses } from "../format-clauses.js";
import type { RegistryFormatClause } from "../format-clauses.js";
import { SIREN_SPACED_TOKEN } from "./identifier-format.js";

/**
 * SIREN identifies companies, associations and public bodies. The adapter
 * supplies no RCS registration fact, so the identifier carries no RCS claim.
 * Share capital and a readable legal form are also unavailable.
 *
 * https://www.insee.fr/fr/information/1972132
 */
export const RECHERCHE_ENTREPRISES_DEFAULT_FORMAT_CLAUSES: readonly RegistryFormatClause[] =
  [
    { template: "**[company name]**", requires: ["company name"] },
    {
      template: "dont le siège social est situé [head office address]",
      requires: ["head office address"],
    },
    {
      template: `numéro SIREN [${SIREN_SPACED_TOKEN}]`,
      requires: [SIREN_SPACED_TOKEN],
    },
  ];

export const RECHERCHE_ENTREPRISES_DEFAULT_FORMAT: string = formatFromClauses(
  RECHERCHE_ENTREPRISES_DEFAULT_FORMAT_CLAUSES,
);
