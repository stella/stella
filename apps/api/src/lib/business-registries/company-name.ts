import { stripDiacritics } from "@stll/text-normalize";

/** Legal-form spellings removed only from the end of a registered name. */
const COMPANY_LEGAL_FORM_SUFFIXES = [
  "spółka z ograniczoną odpowiedzialnością",
  "spolka z ograniczona odpowiedzialnoscia",
  "spółka akcyjna",
  "spolka akcyjna",
  "sp. z o.o.",
  "sp z oo",
  "s.a.",
  "sa",
  "sp.k.",
  "sp k",
  "sp.j.",
  "sp j",
] as const;

const foldPolishCharacters = (value: string): string =>
  value.replaceAll("ł", "l").replaceAll("Ł", "L");

const normalizeWords = (value: string): string =>
  stripDiacritics(foldPolishCharacters(value))
    .toLocaleLowerCase("pl")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");

const NORMALIZED_LEGAL_FORM_SUFFIXES = COMPANY_LEGAL_FORM_SUFFIXES.map(
  normalizeWords,
).toSorted((left, right) => right.length - left.length);

export const normalizeRegisteredCompanyName = (value: string): string => {
  let normalized = normalizeWords(value);
  for (const suffix of NORMALIZED_LEGAL_FORM_SUFFIXES) {
    if (normalized === suffix) {
      return "";
    }
    if (normalized.endsWith(` ${suffix}`)) {
      normalized = normalized.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }
  return normalized;
};
