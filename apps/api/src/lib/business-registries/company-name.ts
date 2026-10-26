import * as v from "valibot";

import { stripDiacritics } from "@stll/text-normalize";

/** Legal-form spellings removed only from the end of a registered name. */
const COMPANY_LEGAL_FORM_SUFFIXES = [
  "spółka z ograniczoną odpowiedzialnością",
  "spolka z ograniczona odpowiedzialnoscia",
  "spółka akcyjna",
  "spolka akcyjna",
  "spółka komandytowa",
  "spółka jawna",
  "spółka partnerska",
  "spółka komandytowo-akcyjna",
  "prosta spółka akcyjna",
  "sp. z o.o.",
  "sp z oo",
  "s.a.",
  "sa",
  "sp.k.",
  "sp k",
  "sp.j.",
  "sp j",
  "sp.p.",
  "sp p",
  "s.k.a.",
  "s k a",
  "p.s.a.",
  "p s a",
] as const;

const RegisteredCompanyNameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.brand("RegisteredCompanyName"),
);

export type RegisteredCompanyName = v.InferOutput<
  typeof RegisteredCompanyNameSchema
>;

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

export const normalizeRegisteredCompanyName = (
  value: string,
): RegisteredCompanyName | null => {
  let normalized = normalizeWords(value);
  for (const suffix of NORMALIZED_LEGAL_FORM_SUFFIXES) {
    if (normalized === suffix) {
      return null;
    }
    if (normalized.endsWith(` ${suffix}`)) {
      normalized = normalized.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }
  const parsed = v.safeParse(RegisteredCompanyNameSchema, normalized);
  return parsed.success ? parsed.output : null;
};
