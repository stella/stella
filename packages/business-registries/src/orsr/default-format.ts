import { formatFromClauses } from "../format-clauses.js";
import type { RegistryFormatClause } from "../format-clauses.js";
import { ORSR_COURT_GENITIVE_TOKEN } from "./court-names.js";
import { ORSR_IDENTIFIER_SPACED_TOKEN } from "./identifier-format.js";

/** Register section ("Sro", "Sa") and insert number carrying its court letter
 *  ("3586/B") — the two halves of the citation an ORSR extract prints. */
export const ORSR_SECTION_TOKEN = "section" as const;
export const ORSR_INSERT_TOKEN = "insert" as const;

/**
 * The Slovak party clause. § 3a Obchodného zákonníka requires the business
 * name, seat, IČO and the register designation on commercial documents; the
 * wording is the register's own ("Výpis z Obchodného registra Mestského súdu
 * Bratislava III, oddiel: Sro, vložka č. 3586/B"), matching the Ministry of
 * Transport's published contract template.
 *
 * https://www.mindop.sk/fileadmin/dokumenty/organizacie_v_posobnosti_ministerstva_dopravy_sr/Vzor_zml%C3%BAv/VP_clen_P.pdf
 */
export const ORSR_DEFAULT_FORMAT_CLAUSES: readonly RegistryFormatClause[] = [
  { template: "**[company name]**", requires: ["company name"] },
  { template: "so sídlom [address]", requires: ["address"] },
  {
    template: `IČO: [${ORSR_IDENTIFIER_SPACED_TOKEN}]`,
    requires: [ORSR_IDENTIFIER_SPACED_TOKEN],
  },
  {
    // All three particulars or none: a register citation missing its court or
    // its insert identifies nothing.
    template: `zapísaná v Obchodnom registri [${ORSR_COURT_GENITIVE_TOKEN}], oddiel: [${ORSR_SECTION_TOKEN}], vložka č. [${ORSR_INSERT_TOKEN}]`,
    requires: [
      ORSR_COURT_GENITIVE_TOKEN,
      ORSR_SECTION_TOKEN,
      ORSR_INSERT_TOKEN,
    ],
  },
];

export const ORSR_DEFAULT_FORMAT: string = formatFromClauses(
  ORSR_DEFAULT_FORMAT_CLAUSES,
);
