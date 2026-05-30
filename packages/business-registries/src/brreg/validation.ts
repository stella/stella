// Norwegian organisasjonsnummer (orgnr).
//
// Nine digits with a MOD-11 check digit. Weights for digits 1..8 are
// [3, 2, 7, 6, 5, 4, 3, 2]; the control digit is the 9th. If the
// MOD-11 remainder would resolve to 10, the orgnr is invalid (since
// the control digit only has room for one digit).
//
// See: https://www.brreg.no/om-oss/oppgavene-vare/registrene-vare/

const ORGNR_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2] as const;

export const normalizeOrgnr = (input: string): string =>
  input.replaceAll(/[\s-]/gu, "");

export const validateOrgnr = (input: string): boolean => {
  const compact = normalizeOrgnr(input);
  if (!/^\d{9}$/u.test(compact)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < ORGNR_WEIGHTS.length; i++) {
    const digit = Number(compact[i]);
    const weight = ORGNR_WEIGHTS[i];
    if (weight === undefined) {
      return false;
    }
    sum += digit * weight;
  }
  const remainder = sum % 11;
  const expectedControl = remainder === 0 ? 0 : 11 - remainder;
  if (expectedControl === 10) {
    return false;
  }
  return expectedControl === Number(compact[8]);
};
