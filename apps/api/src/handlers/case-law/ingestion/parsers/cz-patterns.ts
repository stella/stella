/**
 * Shared regex patterns for Czech court decision parsers.
 *
 * Used by cz-ns, cz-nss, cz-us, and cz-regional parsers for
 * closing formula and signature detection.
 */

/** Closing formula: "V Brně dne 6. ledna 2016", "V Brně dne 25. 10. 2018", etc. */
export const CZ_CLOSING_RE =
  /^(?:V\s+)?\p{Lu}\p{Ll}+\s+(?:dne\s+)?\d{1,2}\.\s*(?:\p{Ll}+\s+|\d{1,2}\.\s*)?\d{4}/u;

/** Judge name prefix: JUDr., Mgr., doc., prof. */
export const CZ_JUDGE_NAME_RE =
  /^(?:JUDr\.|Mgr\.|doc\.|prof\.|PhDr\.|Ing\.|Bc\.|RNDr\.|MUDr\.)\s+/;

/**
 * Judge function title (substring match): předseda/předsedkyně
 * senátu, soudce zpravodaj, samosoudce, v. r.
 */
export const CZ_JUDGE_TITLE_RE =
  /(?:předsed(?:a|kyně|y)\s+senátu:?|samosoudce|samosoudkyně|soud(?:ce|kyně)\s+zpravodaj|v\.\s*r\.\s*$)/i;
