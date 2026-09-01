/**
 * Splitting a published case reference into the docket and what follows it.
 *
 * Some courts append the sheet number within the file (číslo listu) to the
 * docket, as `11 C 153/2025-28`. The two are different things: the docket
 * identifies the case, the sheet identifies where a document sits in it. Kept
 * together, one case fragments into a reference per sheet and no citation
 * matches, because a citation names the docket alone.
 */

/**
 * Trailing `-<digits>` on a reference whose docket already carries a year.
 *
 * The year requirement is what keeps this from biting references that end in a
 * number for another reason: Slovak `0T/42/2019` and Polish `II AKa 198/23`
 * have no trailing group to take, while `11 C 153/2025-28` does. Anchored at
 * the end so an internal dash (`ECLI:CZ:...`) is untouched.
 *
 * Czech courts set the separator either tight or spaced, and the same court
 * does both: a citation line prints `10 A 46/2015-66` where the decision's own
 * header prints `10 A 46/2015 - 66`. A single space on either side is part of
 * the suffix, not of the docket, so both forms reduce to one docket. The
 * docket group ends on a digit, so no spacing can survive into what is stored.
 */
const SHEET_SUFFIX = /^(?<docket>.*\/\d{2,4}) ?- ?(?<sheet>\d+)$/u;

type CaseReference = {
  caseNumber: string;
  sheetNumber: string | undefined;
};

/**
 * The docket and sheet of a published reference. A reference with no sheet
 * comes back unchanged with `sheetNumber` undefined, so this is safe to apply
 * to every source rather than only the ones known to append one.
 */
export const splitCaseReference = (reference: string): CaseReference => {
  const groups = SHEET_SUFFIX.exec(reference.trim())?.groups;
  const docket = groups?.["docket"];
  const sheet = groups?.["sheet"];
  if (docket === undefined || sheet === undefined) {
    return { caseNumber: reference.trim(), sheetNumber: undefined };
  }
  return { caseNumber: docket, sheetNumber: sheet };
};
