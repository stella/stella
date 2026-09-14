import { formatFromClauses } from "../format-clauses.js";
import type { RegistryFormatClause } from "../format-clauses.js";

/**
 * The UK party clause. The company number is never grouped, and the
 * legal form comes from the record, including partnerships. Registration
 * wording also covers limited partnerships, which are not companies.
 *
 * https://find-and-update.company-information.service.gov.uk/company/00445790
 */
export const COMPANIES_HOUSE_DEFAULT_FORMAT_CLAUSES: readonly RegistryFormatClause[] =
  [
    { template: "**[company name]**", requires: ["company name"] },
    {
      template: "[legal form]",
      requires: ["legal form"],
    },
    {
      template: "registered in [jurisdiction]",
      requires: ["jurisdiction"],
      separator: " ",
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
