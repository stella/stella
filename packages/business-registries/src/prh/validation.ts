// Finnish Y-tunnus (business ID).
//
// Format `NNNNNNN-C`: seven digits, a hyphen, then a single check
// digit. The check digit is MOD-11 over the seven payload digits with
// weights [7, 9, 10, 5, 8, 4, 2]. Remainder 0 → check 0; remainder 1
// is invalid (no single digit fits); else check = 11 - remainder.
//
// PRH spec: https://www.vero.fi/en/businesses-and-corporations/about-corporate-taxes/business-id/

const YTUNNUS_WEIGHTS = [7, 9, 10, 5, 8, 4, 2] as const;

export const normalizeBusinessId = (input: string): string =>
  input.trim().replaceAll(/\s/gu, "");

export const validateBusinessId = (input: string): boolean => {
  const compact = normalizeBusinessId(input);
  const match = /^(\d{7})-(\d)$/u.exec(compact);
  if (!match) {
    return false;
  }
  const [, payload, control] = match;
  if (payload === undefined || control === undefined) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < YTUNNUS_WEIGHTS.length; i++) {
    const digit = Number(payload[i]);
    const weight = YTUNNUS_WEIGHTS[i];
    if (weight === undefined) {
      return false;
    }
    sum += digit * weight;
  }
  const remainder = sum % 11;
  if (remainder === 1) {
    return false;
  }
  const expectedControl = remainder === 0 ? 0 : 11 - remainder;
  return expectedControl === Number(control);
};
