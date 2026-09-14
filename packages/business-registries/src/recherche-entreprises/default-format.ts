import { formatFromClauses } from "../format-clauses.js";
import type { RegistryFormatClause } from "../format-clauses.js";
import { SIREN_SPACED_TOKEN } from "./identifier-format.js";

/**
 * The French party clause, per Bpifrance Création's official SAS statutes
 * model and Code de commerce R.123-237.
 *
 * Three particulars the canonical clause carries are absent because the
 * adapter cannot supply them, and stating them from nothing would be worse
 * than omitting them: the share capital ("au capital de … euros") is not in
 * the payload; the legal form arrives only as a raw INSEE category code with
 * no name mapping; and the greffe city is not returned, so the clause names
 * the register without a city rather than guessing one. Add "de [RCS city]"
 * here if the adapter ever exposes the greffe.
 *
 * https://bpifrance-creation.fr/file/555741/download?token=509z4M_H
 */
export const RECHERCHE_ENTREPRISES_DEFAULT_FORMAT_CLAUSES: readonly RegistryFormatClause[] =
  [
    { template: "**[company name]**", requires: ["company name"] },
    {
      template: "dont le siège social est situé [head office address]",
      requires: ["head office address"],
    },
    {
      template: `immatriculée au Registre du commerce et des sociétés sous le numéro [${SIREN_SPACED_TOKEN}]`,
      requires: [SIREN_SPACED_TOKEN],
    },
  ];

export const RECHERCHE_ENTREPRISES_DEFAULT_FORMAT: string = formatFromClauses(
  RECHERCHE_ENTREPRISES_DEFAULT_FORMAT_CLAUSES,
);
