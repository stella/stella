/**
 * The sheet number a citation names, read from just after the docket.
 *
 * Czech courts name a decision by its file number and the sheet the document
 * sits on: "č. j. 8 As 287/2020-33". The docket is the case file, which can
 * hold several decisions; the sheet is what picks one of them out, and it is
 * the last segment of that decision's ECLI
 * (`ECLI:CZ:NSS:2021:8.As.287.2020.33`). The extractor's number pattern stops
 * at the year, so without this the sheet is discarded and a docket answered by
 * more than one decision resolves to none of them.
 *
 * The sheet is never part of the dedup key: one judgment cites the same
 * decision as "sp. zn. 8 As 287/2020" where it invokes the ruling and
 * "č. j. 8 As 287/2020-33" where it names the file, and those are one
 * citation. So this is a hint on the citation, the way the court and type
 * hints are, rather than a second identity.
 */

import { DECISION_DASH_CLASS_SOURCE } from "@stll/api-contract/decision-docket-grammar";

/** Fits the column, and a court file does not run to five-digit sheets. */
export const CITATION_SHEET_NUMBER_MAX_LENGTH = 8;

/**
 * The sheet suffix at the start of what follows a docket.
 *
 * The negative lookahead is what keeps a dash *between two citations* from
 * reading as a sheet: "č. j. 5 As 123/2020 – 5 As 124/2020" would otherwise
 * take the second docket's senate number as the first one's sheet. A run that
 * continues into another docket's registry-and-year shape is a second
 * citation, not a sheet. Ordinary prose after a sheet ("-33 a dále") has no
 * such shape and still binds.
 */
const SHEET_AFTER_DOCKET = new RegExp(
  String.raw`^ ?[${DECISION_DASH_CLASS_SOURCE}] ?(?<sheet>\d{1,4})(?!\d)(?!\s*\p{L}{1,7}[\s/]{1,3}\d{1,6}\/\d{2,4})`,
  "u",
);

/**
 * Enough of what follows the docket for the lookahead to recognise a second
 * citation ("č. j. 5 As 123/2020 – 5 As 124/2020" needs sixteen); a window
 * that truncates the shape would accept the other docket's senate number.
 */
const SHEET_WINDOW_CHARS = 32;

/**
 * The sheet number written directly after the docket ending at `matchEnd`, or
 * null when the text prints none.
 */
export const detectCitationSheetNumber = (
  text: string,
  matchEnd: number,
): string | null =>
  SHEET_AFTER_DOCKET.exec(text.slice(matchEnd, matchEnd + SHEET_WINDOW_CHARS))
    ?.groups?.["sheet"] ?? null;
