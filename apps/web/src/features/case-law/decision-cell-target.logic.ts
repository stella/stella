/**
 * Which version of a decision a link in a results row names.
 *
 * A cell link opens the decision beside the results and carries the full-page
 * URL for the gestures that leave the page. Both are built from one target, so
 * what a reader sees after a click and what they get from ⌘-click can never be
 * two different decisions.
 */

import type { Decision } from "@/features/case-law/components/decision-cells";
import type { DecisionTabTarget } from "@/features/case-law/decision-inspector.logic";
import { pickPreferredCaseLawLanguageVariant } from "@/lib/case-law-language-preference";

type PreferredDecisionTargetOptions = {
  /** The words that found the row; they travel with every gesture that opens it. */
  searchQuery?: string | undefined;
  /** The reader's languages, most preferred first (`useCaseLawReadingLanguages`). */
  readingLanguages: readonly string[];
};

/**
 * The version of a multilingual decision the reader is most likely to want:
 * the first of their reading languages it exists in, otherwise the version
 * the row stands for. A monolingual decision is its own only version.
 */
export const preferredDecisionTarget = (
  decision: Decision,
  { searchQuery, readingLanguages }: PreferredDecisionTargetOptions,
): DecisionTabTarget => {
  const preferred = pickPreferredCaseLawLanguageVariant({
    alternates: decision.languageAlternates,
    rowLanguage: decision.language,
    readingLanguages,
  });
  const terms =
    searchQuery === undefined || searchQuery === "" ? {} : { searchQuery };

  return preferred === null
    ? {
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
        ...terms,
      }
    : {
        caseNumber: preferred.caseNumber,
        country: preferred.country,
        court: preferred.court,
        decisionId: preferred.id,
        language: preferred.language,
        languageAlternates: decision.languageAlternates,
        slug: preferred.slug,
        ...terms,
      };
};
