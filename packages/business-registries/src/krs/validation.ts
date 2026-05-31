// Polish KRS number (numer KRS).
//
// Format: exactly 10 digits, zero-padded (e.g. `0000006865`). KRS
// numbers are sequential identifiers assigned by the Krajowy Rejestr
// Sądowy without a checksum, unlike NIP (MOD-11) or REGON (MOD-11
// over 9 or 14 digits). The validator is therefore a pure shape
// check; semantic correctness can only be confirmed by hitting the
// upstream lookup endpoint.
//
// Whitespace is stripped (humans paste KRS numbers with spaces, or
// from copy-pasted tables); the leading-zero padding is preserved.
// We deliberately do NOT pad shorter inputs: a user-supplied "6865"
// is ambiguous (could be an arbitrary numeric identifier), and the
// dispatch layer keys on a shape match to choose lookup vs. search.

export const normalizeKrsNumber = (input: string): string =>
  input.trim().replaceAll(/\s/gu, "");

export const validateKrsNumber = (input: string): boolean => {
  const compact = normalizeKrsNumber(input);
  return /^\d{10}$/u.test(compact);
};
