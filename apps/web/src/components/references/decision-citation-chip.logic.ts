import { isValidElement } from "react";
import type { ReactNode } from "react";

import { courtAbbreviation } from "@stll/api-contract/case-law-court-abbreviations";
import type { CourtAbbreviationInput } from "@stll/api-contract/case-law-court-abbreviations";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";

import { DECISION_CITATION_PRESENTATION } from "@/components/references/decision-citation-presentation.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

export type DecisionCitationMetadata = {
  decisionId: string;
  court: string;
  courtShortCode: string;
  caseNumber: string;
  decisionDate: string | null;
  readerUrl: string;
  originalUrl: string | null;
};

type DecisionCitationCourtInput = CourtAbbreviationInput & {
  courtAbbreviation?: string | null | undefined;
};

// Spacing, dash typography and case vary between a model's prose and the
// registry ("III. ÚS 2429/24" against "III.ÚS 2429/24"); the characters and
// separators that identify the case do not ("1/23" is not "12/3").
const IDENTIFIER_CHARACTER = /[\p{L}\p{N}]/u;
const SPACING = /\s/u;
// Every dash a docket may be typed with; the suffix patterns use the same set.
const DASH = /[\u2010-\u2015\u2212]/u;
const CASE_NUMBER_SUFFIX = /[-\u2010-\u2015\u2212]\s*[\p{L}\p{N}]+$/u;
// A registry suffix is numbered ("-7", " - 123"), with or without a space
// before the dash; a dash followed by words ("651/2023—the court held") opens
// a clause and stays prose.
const LEADING_CASE_NUMBER_SUFFIX =
  /^\s*[-\u2010-\u2015\u2212]\s*\p{N}[\p{L}\p{N}]*/u;
// Outside dated dockets a dash glued to the next word or number continues the
// identifier ("A-123-B" is not "A-123").
const JOINED_SEGMENT = /^[-\u2010-\u2015\u2212][\p{L}\p{N}]/u;

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
const normalizeDecisionCaseNumber = (value: string): string =>
  comparable(value).text;

/** Text content of Markdown link children, including inline formatting. */
const citationNodeText = (node: ReactNode): string => {
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
  // A court decoration is a separate word before the number ("NS 23 Cdo",
  // "BVerfG, 1 BvR"); a letter joined to the number by a hyphen ("A-123-B")
  // is part of the identifier and is never dropped.
  const firstDigit = withoutSuffix.search(/\p{N}/u);
  const decorated =
    firstDigit > 0 && /[\s,]/u.test(withoutSuffix.charAt(firstDigit - 1));
  const withoutCourtPrefix =
    decorated && /\p{L}/u.test(withoutSuffix.slice(firstDigit + 1))
      ? withoutSuffix.slice(firstDigit)
      : "";
  return [...new Set([withoutSuffix, withoutCourtPrefix])]
    .map(normalizeDecisionCaseNumber)
    .filter((candidate) => candidate.length > 0)
    .toSorted((left, right) => right.length - left.length);
};

/** Locates the registry case number in prose after normalising punctuation and spacing. */
const citationTextCaseMatch = (
  text: string,
  caseNumber: string,
): CitationTextMatch | null => {
  const prose = comparable(text);
  const storedSuffix =
    withoutRegistrySuffix(caseNumber) === caseNumber
      ? undefined
      : CASE_NUMBER_SUFFIX.exec(caseNumber)?.at(0);
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
      const after = text.slice(last + 1);
      const dated = DATED_DOCKET.test(text.slice(first, last + 1));
      if (!dated && JOINED_SEGMENT.test(after)) {
        continue;
      }
      const suffix = dated
        ? LEADING_CASE_NUMBER_SUFFIX.exec(after)?.at(0)
        : undefined;
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

type InlineDecisionCitationPresentation =
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

/**
 * How a citation drawn beside the text it was found in presents itself. The
 * expanded chip repeats the case number so two decisions of one court read
 * apart; text that already prints that number has told them apart, so its
 * chip keeps only the court.
 */
export const presentationBesideCitationText = ({
  caseNumber,
  citationText,
  presentation,
}: {
  caseNumber: string;
  citationText: string;
  presentation: DecisionCitationPresentation;
}): DecisionCitationPresentation =>
  citationTextNamesCase(citationText, caseNumber)
    ? DECISION_CITATION_PRESENTATION.compact
    : presentation;

/** What a citation shows of a loaded decision, and where it opens. */
export const decisionCitationMetadata = (
  decision: PublicCaseLawDecision,
): DecisionCitationMetadata => ({
  decisionId: decision.id,
  court: decision.court,
  courtShortCode: decisionCitationCourtLabel(decision),
  caseNumber: decision.caseNumber,
  decisionDate: decision.decisionDate,
  readerUrl: createCaseLawDecisionPath(
    createCaseLawDecisionRouteParams({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionId: decision.id,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
    }),
  ),
  originalUrl: decision.sourceUrl ?? decision.documentUrl ?? null,
});
