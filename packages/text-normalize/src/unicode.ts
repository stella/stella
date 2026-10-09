export const UNICODE_NORMALIZATION_FORMS = [
  "NFC",
  "NFD",
  "NFKC",
  "NFKD",
] as const;

export type UnicodeNormalizationForm =
  (typeof UNICODE_NORMALIZATION_FORMS)[number];

export type UnicodeMarkClass = "combining" | "diacritic" | "basic-combining";

type StripUnicodeMarksOptions = {
  form: UnicodeNormalizationForm;
  markClass: UnicodeMarkClass;
};

const COMBINING_MARKS = /\p{M}/gu;
const DIACRITICS = /\p{Diacritic}/gu;
const BASIC_COMBINING_MARKS = /[\u0300-\u036f]/gu;
const MARK_PATTERNS = {
  combining: COMBINING_MARKS,
  diacritic: DIACRITICS,
  "basic-combining": BASIC_COMBINING_MARKS,
} as const satisfies Record<UnicodeMarkClass, RegExp>;

/** Applies one explicit Unicode normalization form without additional folding. */
export const normalizeUnicode = (
  text: string,
  form: UnicodeNormalizationForm,
): string => text.normalize(form);

/** Normalizes text, then removes the caller's exact historical mark class. */
export const stripUnicodeMarks = (
  text: string,
  { form, markClass }: StripUnicodeMarksOptions,
): string => {
  const normalized = normalizeUnicode(text, form);
  return normalized.replaceAll(MARK_PATTERNS[markClass], "");
};
