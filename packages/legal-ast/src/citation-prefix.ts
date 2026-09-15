/**
 * The words a decision prints before a case number, in one place.
 *
 * The same case reaches a reader under several of them: a Czech judgment
 * writes "sp. zn. 4 Tdo 1323/2020" where it invokes the ruling and
 * "č. j. 4 Tdo 1323/2020-906" where it names the file, and both name the
 * same decision. Extraction stores whichever spelling it matched, so every
 * consumer that compares or locates a citation has to see past the prefix.
 *
 * Two lists would disagree: the extractor's dedup key strips the prefix to
 * decide that two mentions are one citation, and the reader strips it to
 * mark every mention in the text. A prefix known to one and not the other
 * splits one case into two keys, or leaves a mention unmarked.
 *
 * Every source below is case-insensitive by the caller's flag, not by its
 * own spelling: "Sygn. akt" opens a Polish document header and "sygn. akt"
 * runs in its prose.
 *
 * `č` is written `[čc]\p{Mn}*` because publishers serve it both precomposed
 * (U+010D) and decomposed (U+0063 U+030C), and nothing normalizes a
 * decision's text: without the mark the class reads a decomposed "č" as a
 * bare "c" and the prefix stops matching at the caron.
 */

/** Czech/Slovak file number: `č. j.`, `č.j.`, the contracted `čj.`. */
export const CZ_FILE_NUMBER_PREFIX_SOURCE = String.raw`[čc]\p{Mn}*\.?\s*j\.:?\s*`;

/** Czech/Slovak docket reference: `sp. zn.`, `sp.zn.:`, `sp. zn` (no dot). */
const CZ_DOCKET_PREFIX_SOURCE = String.raw`sp\.\s*zn\.?:?\s*`;

/** Czech senate docket reference, used for grand-panel numbers: `sen. zn.`. */
const CZ_SENATE_PREFIX_SOURCE = String.raw`sen\.\s*zn\.:?\s*`;

/** Slovak file number (číslo konania): `č. k.`, `č.k.`. */
const SK_FILE_NUMBER_PREFIX_SOURCE = String.raw`[čc]\p{Mn}*\.\s*k\.:?\s*`;

/** Polish docket reference: `sygn.`, `sygn. akt`, `sygn.: `, `sygn. akt:`. */
const PL_DOCKET_PREFIX_SOURCE = String.raw`sygn\.\s*(?::\s*)?(?:akt\.?:?\s*)?`;

/** Any citation prefix, as a regular-expression source with no captures. */
export const CITATION_PREFIX_SOURCE = `(?:${[
  CZ_DOCKET_PREFIX_SOURCE,
  CZ_SENATE_PREFIX_SOURCE,
  CZ_FILE_NUMBER_PREFIX_SOURCE,
  SK_FILE_NUMBER_PREFIX_SOURCE,
  PL_DOCKET_PREFIX_SOURCE,
].join("|")})`;

const LEADING_CITATION_PREFIX = new RegExp(
  String.raw`^${CITATION_PREFIX_SOURCE}(?<caseNumber>.+)`,
  "isu",
);

/**
 * The bare case number: the citation with its prefix removed.
 *
 * The dotAll flag is load-bearing. `citationText` is stored verbatim,
 * line-wrap newline included, and a `.+` without it stops at the break and
 * truncates the number.
 */
export const stripCitationPrefix = (text: string): string => {
  const trimmed = text.trim();
  const caseNumber =
    LEADING_CITATION_PREFIX.exec(trimmed)?.groups?.["caseNumber"];
  return caseNumber === undefined ? trimmed : caseNumber.trim();
};
