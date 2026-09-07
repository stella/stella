export const normalizeKrsNumber = (input: string): string =>
  input.trim().replaceAll(/\s/gu, "");

export const validateKrsNumber = (input: string): boolean =>
  /^\d{10}$/u.test(normalizeKrsNumber(input));
