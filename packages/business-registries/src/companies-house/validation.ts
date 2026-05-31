// UK Companies House company number (CRN).
//
// Eight characters, alphanumeric, uppercase. Jurisdiction is encoded
// in an optional two-letter prefix; the remaining characters are
// zero-padded digits:
//   * England & Wales: `12345678` (8 digits, leading zero common).
//   * Scotland: `SC012345`.
//   * Northern Ireland: `NI012345`.
//   * Special prefixes: `OC` (LLP, E&W), `SO` (LLP, Scotland), `NC`
//     (LLP, NI), `LP` (limited partnership), `SL` / `NL` (LP, S / NI),
//     `RC` (royal charter), `SR` (royal charter, Scotland), `ZC`
//     (industrial & provident), `IC` (investment company), `IP`
//     (industrial & provident, NI / Scotland), `FC` (overseas E&W),
//     `SF` (overseas Scotland), `NF` (overseas NI), `GE` (EEIG), etc.
//
// There is no documented checksum on the CRN, so validation is purely
// structural: 2 letters + 6 digits, or 8 digits (with a leading zero
// for E&W incorporations earlier in the alphabet).
//
// We accept any 1–8 character input (with optional whitespace, lowercase
// letters, or an unpadded numeric portion) and normalise to the
// 8-character canonical form.
//
// See: https://developer.company-information.service.gov.uk/

// Either a real two-letter prefix or the special-case `R0` (the only
// prefix where the second character is a digit — see the
// `CANONICAL_PATTERN` note below).
const TWO_LETTER_PREFIX_PATTERN = /^(R0|[A-Z]{2})(\d{1,6})$/u;
const ALL_DIGITS_PATTERN = /^\d{1,8}$/u;

export const normalizeCompanyNumber = (input: string): string => {
  const upper = input.trim().replaceAll(/\s/gu, "").toUpperCase();
  const prefixed = TWO_LETTER_PREFIX_PATTERN.exec(upper);
  if (prefixed) {
    const prefix = prefixed[1] ?? "";
    const digits = prefixed[2] ?? "";
    return `${prefix}${digits.padStart(6, "0")}`;
  }
  if (ALL_DIGITS_PATTERN.test(upper)) {
    return upper.padStart(8, "0");
  }
  // Unknown shape — return the upper-cased trimmed input so the caller
  // sees what was attempted in the validation error.
  return upper;
};

// Most jurisdiction prefixes are two letters (`SC`, `NI`, `OC`, ...).
// `R0` is the one outlier — Companies House's URI guide reserves it
// for pre-partition Northern Ireland companies (pre-1922) and the
// `0` is part of the prefix code, not a digit of the sequence
// number. Treat it as a fixed alternative rather than broadening to
// `[A-Z][A-Z0-9]` (which would silently admit invented prefixes like
// `Q9`).
const CANONICAL_PATTERN = /^(?:R0\d{6}|[A-Z]{2}\d{6}|\d{8})$/u;

export const validateCompanyNumber = (input: string): boolean => {
  const normalized = normalizeCompanyNumber(input);
  if (!CANONICAL_PATTERN.test(normalized)) {
    return false;
  }
  // The all-zero CRN is reserved and never assigned; reject so callers
  // do not waste a Companies House quota slot on an obviously-invalid
  // lookup.
  return normalized !== "00000000";
};
