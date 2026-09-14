import type { OrsrCourtFile } from "./types.js";

/**
 * The insert number as the register cites it: the vložka number followed by
 * its court letter, "3586/B". The letter belongs to the insert, not in front
 * of the citation — an ORSR extract prints "Vložka číslo: 3586/B".
 */
export const formatOrsrInsert = (
  file: Pick<OrsrCourtFile, "court" | "insertNumber">,
): string => `${file.insertNumber}/${file.court}`;

/**
 * The whole file reference, "Sro 3586/B" — the register's own
 * `formattedValueSpaced`.
 */
export const formatOrsrCourtFile = (
  file: Pick<OrsrCourtFile, "court" | "insertNumber" | "section">,
): string => `${file.section} ${formatOrsrInsert(file)}`;
