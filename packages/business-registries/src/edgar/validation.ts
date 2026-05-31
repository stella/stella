// SEC Central Index Key (CIK).
//
// A CIK is a non-negative integer (1 to 10 digits) the SEC assigns to
// every issuer, filer, and insider. There is no checksum. The
// canonical wire format on the `submissions` endpoint is
// zero-padded to 10 digits (e.g. `0000320193` for Apple Inc.);
// elsewhere on the SEC site the leading zeros are dropped.
//
// We accept any 1–10 digit input (with optional whitespace, leading
// "CIK"/"cik#" prefix, or zero padding) and normalise to the
// zero-padded 10-digit canonical form.
//
// See: https://www.sec.gov/edgar/searchedgar/cik.htm

const CIK_PREFIX_PATTERN = /^cik#?/iu;

export const normalizeCik = (input: string): string => {
  const trimmed = input.trim().replace(CIK_PREFIX_PATTERN, "");
  // Strip whitespace AND leading zeros so we can re-pad to a stable
  // 10-digit width regardless of how many zeros the caller supplied.
  const digits = trimmed.replaceAll(/\s/gu, "").replace(/^0+/u, "");
  return digits.length === 0 ? "0" : digits;
};

export const padCik = (input: string): string => {
  const normalized = normalizeCik(input);
  return normalized.padStart(10, "0");
};

export const validateCik = (input: string): boolean => {
  const normalized = normalizeCik(input);
  if (!/^\d{1,10}$/u.test(normalized)) {
    return false;
  }
  // "0" alone is reserved / not a real issuer; reject it so callers
  // don't accidentally hit the SEC with an obviously invalid lookup.
  return normalized !== "0";
};
