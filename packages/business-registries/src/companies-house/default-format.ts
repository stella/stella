import { formatFromClauses } from "../format-clauses.js";
import type { RegistryFormatClause } from "../format-clauses.js";

/**
 * The UK party clause. The company number is never grouped, and the
 * jurisdiction of incorporation is what the clause names — Companies House
 * registers companies for England and Wales, Scotland and Northern Ireland
 * separately.
 *
 * https://find-and-update.company-information.service.gov.uk/company/00445790
 */
export const COMPANIES_HOUSE_DEFAULT_FORMAT_CLAUSES: readonly RegistryFormatClause[] =
  [
    { template: "**[company name]**", requires: ["company name"] },
    {
      template: "a company incorporated in [jurisdiction]",
      requires: ["jurisdiction"],
    },
    {
      template: "(company number [registry number])",
      requires: ["registry number"],
      separator: " ",
    },
    {
      template: "whose registered office is at [address]",
      requires: ["address"],
      separator: " ",
    },
  ];

export const COMPANIES_HOUSE_DEFAULT_FORMAT: string = formatFromClauses(
  COMPANIES_HOUSE_DEFAULT_FORMAT_CLAUSES,
);
