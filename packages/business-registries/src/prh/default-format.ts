import { formatFromClauses } from "../format-clauses.js";
import type { RegistryFormatClause } from "../format-clauses.js";

/**
 * The Finnish party clause. PRH issues the Y-tunnus already hyphenated
 * ("0992445-3"), so it needs no regrouping; Finnish contracts set it in
 * parentheses after the name.
 *
 * https://www.ytj.fi/en/index/businessid.html
 */
export const PRH_DEFAULT_FORMAT_CLAUSES: readonly RegistryFormatClause[] = [
  { template: "**[company name]**", requires: ["company name"] },
  {
    template: "(Y-tunnus [registry number])",
    requires: ["registry number"],
    separator: " ",
  },
  { template: "[address]", requires: ["address"] },
];

export const PRH_DEFAULT_FORMAT: string = formatFromClauses(
  PRH_DEFAULT_FORMAT_CLAUSES,
);
