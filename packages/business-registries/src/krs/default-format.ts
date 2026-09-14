import { formatFromClauses } from "../format-clauses.js";
import type { RegistryFormatClause } from "../format-clauses.js";

/**
 * The Polish komparycja. Art. 206 § 1 and art. 374 § 1 KSH require the firm,
 * seat and address, the registry-court designation and KRS number, the NIP and
 * (for a spółka akcyjna) the share capital. The court designation is
 * deliberately absent: the API exposes only "the court that made the last
 * entry", which can read "SYSTEM" and arrives as an unnormalized all-caps
 * blob, so naming a court here would risk naming the wrong one.
 * The KRS number covers both RejP and RejS; the clause names no sub-register.
 *
 * https://lexlege.pl/ksh/art-206/
 * https://umowywit.pl/strony-umowy-wdrozeniowej-jak-oznaczyc/
 */
export const KRS_DEFAULT_FORMAT_CLAUSES: readonly RegistryFormatClause[] = [
  { template: "**[company name]**", requires: ["company name"] },
  // Labelled rather than the idiomatic "z siedzibą w …": that phrasing puts
  // the locality in the locative ("w Poznaniu"), and the register supplies the
  // nominative ("Poznań"). Polish locality inflection is open-ended, so the
  // label keeps the particular without inventing a case ending.
  { template: "siedziba: [seat]", requires: ["seat"] },
  { template: "adres: [address]", requires: ["address"] },
  {
    template: "numer w Krajowym Rejestrze Sądowym: [registry number]",
    requires: ["registry number"],
  },
  { template: "NIP [NIP]", requires: ["NIP"] },
  { template: "REGON [REGON]", requires: ["REGON"] },
  {
    template: "kapitał zakładowy [share capital]",
    requires: ["share capital"],
  },
];

export const KRS_DEFAULT_FORMAT: string = formatFromClauses(
  KRS_DEFAULT_FORMAT_CLAUSES,
);
