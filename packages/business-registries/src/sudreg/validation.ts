export const normalizeMbs = (input: string): string =>
  input.trim().replaceAll(/\s/gu, "");

export const validateMbs = (input: string): boolean =>
  /^\d{9}$/u.test(normalizeMbs(input));
