import { courtAbbreviation } from "@stll/api-contract/case-law-court-abbreviations";
import type { CourtAbbreviationInput } from "@stll/api-contract/case-law-court-abbreviations";

type DecisionCitationCourtInput = CourtAbbreviationInput & {
  courtAbbreviation?: string | null | undefined;
};

// Spacing and case vary between a model's prose and the registry ("III. ÚS
// 2429/24" against "III.ÚS 2429/24"); the characters that identify the case
// do not.
const comparableCaseNumber = (value: string): string =>
  value.replace(/\s+/gu, "").toLocaleLowerCase("und");

/**
 * Whether cited prose already names the decision by its case number, so the
 * prose itself can carry the citation without a badge repeating the court.
 */
export const citationTextNamesCase = (
  text: string,
  caseNumber: string,
): boolean => {
  const needle = comparableCaseNumber(caseNumber);
  return needle.length > 0 && comparableCaseNumber(text).includes(needle);
};

/** Hydrated registry codes take precedence; unregistered courts retain their name. */
export const decisionCitationCourtLabel = ({
  courtAbbreviation: registeredCode,
  ...court
}: DecisionCitationCourtInput): string =>
  registeredCode ?? courtAbbreviation(court) ?? court.court;
