export const normalizeEstablishmentId = (input: string): string =>
  input.trim().replaceAll(/\s/gu, "");

export const validateEstablishmentId = (input: string): boolean =>
  /^\d{1,12}$/u.test(normalizeEstablishmentId(input));

export const normalizeStateCode = (input: string): string =>
  input.trim().padStart(2, "0");

// INEGI's federal-entity codes run 01-32 (the 31 states plus Ciudad de
// México). "00" is DENUE's explicit national/all-states sentinel used by
// the search endpoint; it is valid but is not itself a state.
const NATIONAL_STATE_CODE = "00";
const MIN_STATE_CODE = 1;
const MAX_STATE_CODE = 32;

export const validateStateCode = (input: string): boolean => {
  const normalized = normalizeStateCode(input);
  if (!/^\d{2}$/u.test(normalized)) {
    return false;
  }
  if (normalized === NATIONAL_STATE_CODE) {
    return true;
  }
  // Real state codes are 01-32; the previous `value >= 0` lower bound
  // was a no-op for two-digit input (it accepted anything up to 32,
  // including bogus non-national low codes) and did not express intent.
  const value = Number(normalized);
  return value >= MIN_STATE_CODE && value <= MAX_STATE_CODE;
};
