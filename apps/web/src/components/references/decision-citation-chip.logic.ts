import { courtAbbreviation } from "@stll/api-contract/case-law-court-abbreviations";
import type { CourtAbbreviationInput } from "@stll/api-contract/case-law-court-abbreviations";

type DecisionCitationCourtInput = CourtAbbreviationInput & {
  courtAbbreviation?: string | null | undefined;
};

// Spacing and case vary between a model's prose and the registry ("III. ÚS
// 2429/24" against "III.ÚS 2429/24"); the characters that identify the case
// do not.
const WHITESPACE = /\s/u;
const IDENTIFIER_CHARACTER = /[\p{L}\p{N}]/u;

/** The characters that identify a case, with each one's index in `value`. */
const comparable = (value: string): { text: string; origin: number[] } => {
  let text = "";
  const origin: number[] = [];
  // UTF-16 units, so each index is a position in `value`.
  for (const [index, character] of value.split("").entries()) {
    if (WHITESPACE.test(character)) {
      continue;
    }
    // Lowercasing can lengthen a character ("İ"); each unit maps back to it.
    const lowered = character.toLocaleLowerCase("und");
    text += lowered;
    for (const _unit of lowered.split("")) {
      origin.push(index);
    }
  }
  return { text, origin };
};

/**
 * Whether cited prose already names the decision by its case number, so the
 * prose itself can carry the citation without a badge repeating the court.
 * The number must stand on its own in the prose: "VIII. ÚS 2429/24" or
 * "2429/240" name other cases.
 */
export const citationTextNamesCase = (
  text: string,
  caseNumber: string,
): boolean => {
  const needle = comparable(caseNumber).text;
  if (needle.length === 0) {
    return false;
  }
  const prose = comparable(text);
  for (
    let at = prose.text.indexOf(needle);
    at !== -1;
    at = prose.text.indexOf(needle, at + 1)
  ) {
    const first = prose.origin.at(at) ?? 0;
    const last = prose.origin.at(at + needle.length - 1) ?? 0;
    if (
      !IDENTIFIER_CHARACTER.test(text.charAt(first - 1)) &&
      !IDENTIFIER_CHARACTER.test(text.charAt(last + 1))
    ) {
      return true;
    }
  }
  return false;
};

/** Hydrated registry codes take precedence; unregistered courts retain their name. */
export const decisionCitationCourtLabel = ({
  courtAbbreviation: registeredCode,
  ...court
}: DecisionCitationCourtInput): string =>
  registeredCode ?? courtAbbreviation(court) ?? court.court;
