export const normalizeEstablishmentId = (input: string): string =>
  input.trim().replaceAll(/\s/gu, "");

export const validateEstablishmentId = (input: string): boolean =>
  /^\d{1,12}$/u.test(normalizeEstablishmentId(input));

export const normalizeStateCode = (input: string): string =>
  input.trim().padStart(2, "0");

export const validateStateCode = (input: string): boolean => {
  const normalized = normalizeStateCode(input);
  if (!/^\d{2}$/u.test(normalized)) {
    return false;
  }
  const value = Number(normalized);
  return value >= 0 && value <= 32;
};
