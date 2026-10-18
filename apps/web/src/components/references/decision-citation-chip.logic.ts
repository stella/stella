import { isValidElement } from "react";
import type { ReactNode } from "react";

import { courtAbbreviation } from "@stll/api-contract/case-law-court-abbreviations";
import type { CourtAbbreviationInput } from "@stll/api-contract/case-law-court-abbreviations";

type DecisionCitationCourtInput = CourtAbbreviationInput & {
  courtAbbreviation?: string | null | undefined;
};

// Spacing, dash typography and case vary between a model's prose and the
// registry ("III. ÚS 2429/24" against "III.ÚS 2429/24"); the characters and
// separators that identify the case do not ("1/23" is not "12/3").
const IDENTIFIER_CHARACTER = /[\p{L}\p{N}]/u;
const SPACING = /\s/u;
const DASH = /[\u2010-\u2015\u2212]/u;
const CASE_NUMBER_SUFFIX = /[-\u2013\u2014]\s*[\p{L}\p{N}]+$/u;
// A suffix in prose may follow a space ("23 Cdo 651/2023 -123"); spaced, it
// must start with a digit, so a dash opening a clause ("... 651/2023 - the
// court held") stays prose.
const LEADING_CASE_NUMBER_SUFFIX =
  /^(?:[-\u2013\u2014]\s*[\p{L}\p{N}]+|\s+[-\u2013\u2014]\s*\p{N}[\p{L}\p{N}]*)/u;

/** The characters that identify a case, with each one's index in `value`. */
const comparable = (value: string): { text: string; origin: number[] } => {
  let text = "";
  const origin: number[] = [];
  // UTF-16 units, so each index is a position in `value`.
  for (const [index, character] of value.split("").entries()) {
    if (SPACING.test(character)) {
      continue;
    }
    // Lowercasing can lengthen a character ("İ"); each unit maps back to it.
    const lowered = DASH.test(character)
      ? "-"
      : character.toLocaleLowerCase("und");
    text += lowered;
    for (const _unit of lowered.split("")) {
      origin.push(index);
    }
  }
  return { text, origin };
};

/** Locale-neutral form used only to compare decision identifiers. */
export const normalizeDecisionCaseNumber = (value: string): string =>
  comparable(value).text;

/** Text content of Markdown link children, including inline formatting. */
export const citationNodeText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    if (Array.isArray(node)) {
      return node.map(citationNodeText).join("");
    }
    return "";
  }
  return citationNodeText(node.props.children);
};

type CitationTextMatch = { start: number; end: number };

// A registry suffix follows a dated docket ("23 Cdo 651/2023-7"). Elsewhere a
// hyphenated segment is the identifier itself ("A-123", "17-1618"), so it is
// never stripped there.
const DATED_DOCKET = /\/\s*\p{N}{2,4}$/u;

const withoutRegistrySuffix = (caseNumber: string): string => {
  const stripped = caseNumber.replace(CASE_NUMBER_SUFFIX, "");
  return DATED_DOCKET.test(stripped) ? stripped : caseNumber;
};

const caseNumberCandidates = (caseNumber: string): string[] => {
  const withoutSuffix = withoutRegistrySuffix(caseNumber);
  const firstDigit = withoutSuffix.search(/\p{N}/u);
  const withoutCourtPrefix =
    firstDigit >= 0 && /\p{L}/u.test(withoutSuffix.slice(firstDigit + 1))
      ? withoutSuffix.slice(firstDigit)
      : "";
  return [...new Set([withoutSuffix, withoutCourtPrefix])]
    .map(normalizeDecisionCaseNumber)
    .filter((candidate) => candidate.length > 0)
    .toSorted((left, right) => right.length - left.length);
};

/** Locates the registry case number in prose after normalising punctuation and spacing. */
export const citationTextCaseMatch = (
  text: string,
  caseNumber: string,
): CitationTextMatch | null => {
  const prose = comparable(text);
  const storedSuffix =
    withoutRegistrySuffix(caseNumber) === caseNumber
      ? undefined
      : caseNumber.match(CASE_NUMBER_SUFFIX)?.at(0);
  for (const needle of caseNumberCandidates(caseNumber)) {
    for (
      let at = prose.text.indexOf(needle);
      at !== -1;
      at = prose.text.indexOf(needle, at + 1)
    ) {
      const first = prose.origin.at(at) ?? 0;
      const last = prose.origin.at(at + needle.length - 1) ?? 0;
      // Only a dated docket carries a registry suffix; anywhere else a
      // following hyphenated segment makes it a longer, different identifier.
      const trailing = text
        .slice(last + 1)
        .match(LEADING_CASE_NUMBER_SUFFIX)
        ?.at(0);
      const dated = DATED_DOCKET.test(text.slice(first, last + 1));
      if (!dated && trailing !== undefined) {
        continue;
      }
      const suffix = dated ? trailing : undefined;
      const end = last + 1 + (suffix?.length ?? 0);
      if (
        !IDENTIFIER_CHARACTER.test(text.charAt(first - 1)) &&
        !IDENTIFIER_CHARACTER.test(text.charAt(end)) &&
        !(
          suffix !== undefined &&
          storedSuffix !== undefined &&
          normalizeDecisionCaseNumber(suffix) !==
            normalizeDecisionCaseNumber(storedSuffix)
        )
      ) {
        return { start: first, end };
      }
    }
  }
  return null;
};

export type InlineDecisionCitationPresentation =
  | { kind: "chip-replaces-text"; before: string; after: string }
  // The prose does not name the case: it stays, and the chip after it shows
  // the verified identity, so a link label can never stand in for it.
  | { kind: "chip-after-text"; label: ReactNode };

/** Chooses the only two valid inline citation shapes. */
export const inlineDecisionCitationPresentation = (
  label: ReactNode,
  caseNumber: string,
): InlineDecisionCitationPresentation => {
  const text = citationNodeText(label);
  const match = citationTextCaseMatch(text, caseNumber);
  if (match === null) {
    return { kind: "chip-after-text", label };
  }
  return {
    kind: "chip-replaces-text",
    before: text.slice(0, match.start),
    after: text.slice(match.end),
  };
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
): boolean => citationTextCaseMatch(text, caseNumber) !== null;

/** Hydrated registry codes take precedence; unregistered courts retain their name. */
export const decisionCitationCourtLabel = ({
  courtAbbreviation: registeredCode,
  ...court
}: DecisionCitationCourtInput): string =>
  registeredCode ?? courtAbbreviation(court) ?? court.court;
