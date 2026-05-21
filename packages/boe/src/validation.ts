// BOE document IDs follow the pattern BOE-[A|B|C|S|T]-YYYY-NNNNN.
// A = Disposiciones generales, B = Autoridades y personal, etc.
// We accept any single uppercase letter to stay forward-compatible.
const LAW_ID_PATTERN = /^BOE-[A-Z]-\d{4}-\d+$/u;

const DATE_PATTERN = /^\d{8}$/u;

export const validateLawId = (id: string): boolean => LAW_ID_PATTERN.test(id);

/**
 * BOE date format is YYYYMMDD (e.g. 20260510).
 * Validates shape only; does not assert the date exists in the gazette.
 */
export const validateBoeDate = (date: string): boolean => {
  if (!DATE_PATTERN.test(date)) {
    return false;
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  return year >= 1960 && year <= 2100;
};

/** Convert ISO date (YYYY-MM-DD) to BOE format (YYYYMMDD). Pass-through if already compact. */
export const toBoeDate = (input: string): string => input.replaceAll("-", "");
