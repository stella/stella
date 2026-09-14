export const ORSR_IDENTIFIER_SPACED_TOKEN = "registry number spaced" as const;

const EIGHT_DIGITS_RE = /^\d{8}$/u;

/** Slovak practice groups an eight-digit IČO as "dd ddd ddd" — the grouping
 *  the register prints itself ("IČO: 00 151 653"), and two digits ahead of the
 *  Czech "ddd dd ddd". Leading zeros are kept, never trimmed. Anything else
 *  (already grouped, foreign, malformed) is returned untouched, which also
 *  makes the grouping idempotent.
 *
 *  https://www.orsr.sk/vypis.asp?ID=19812&SID=2&P=0 */
export const formatOrsrIdentifierSpaced = (identifier: string): string =>
  EIGHT_DIGITS_RE.test(identifier)
    ? `${identifier.slice(0, 2)} ${identifier.slice(2, 5)} ${identifier.slice(5)}`
    : identifier;
