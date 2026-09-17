/**
 * Finding a court-decision reference in a sentence the writer selected, and
 * deciding how the answer reads.
 *
 * The editor offers "Check citation" only where there is something to check,
 * so the selection has to be scanned before the menu opens. Scanning does not
 * mean a second grammar: the candidates are windows of whitespace-separated
 * words, and `parseDecisionQuery` — the same reader the case-law search box
 * and the citator use — is what decides whether a window is an identifier.
 * A pattern shaped like the grammars would agree with them exactly until one
 * of them changed.
 */

import type { CitationRelationReading } from "@stll/api-contract/citation-check";
import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";

import type { TranslationKey } from "@/i18n/types";

/**
 * Words a docket can span: `I. ÚS 1234/20` and `8 Afs 75/2005-130` are three,
 * and no declared grammar writes one in more.
 */
const IDENTIFIER_MAX_WORDS = 4;

/** Punctuation the surrounding sentence leaves on a reference. */
const SURROUNDING_PUNCTUATION = /^[([{"'«‚‘„]+|[.,;:!?)\]}"'»„“”]+$/gu;

/**
 * A reference carries a court's register mark, which is never one letter.
 *
 * Without this the scan offers the action on `č. 89/2012`, a statute number,
 * which every Czech brief is full of: it is a well-formed docket to the
 * grammar and resolves to nothing. The action is an offer, so the cost of
 * declining a real one-letter register is a menu entry that does not appear,
 * while the cost of accepting statute numbers is the entry appearing on half
 * the paragraphs in a pleading.
 */
const REGISTER_MARK = /\p{L}{2}/u;

/**
 * The first court-decision reference the text names, as it is written.
 *
 * Leftmost first, longest at that position: `21 Cdo 1234/2020` beats the
 * `Cdo 1234/2020` inside it, which the grammar also accepts.
 */
export const findDecisionReference = (text: string): string | null => {
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  for (let start = 0; start < words.length; start += 1) {
    for (
      let span = Math.min(IDENTIFIER_MAX_WORDS, words.length - start);
      span > 0;
      span -= 1
    ) {
      const candidate = words
        .slice(start, start + span)
        .join(" ")
        .replace(SURROUNDING_PUNCTUATION, "");
      if (!REGISTER_MARK.test(candidate)) {
        continue;
      }
      if (parseDecisionQuery(candidate).type === "identifier") {
        return candidate;
      }
    }
  }
  return null;
};

/**
 * How each answer reads: one tone and one label per relation, total over the
 * vocabulary the endpoint answers with, so a relation added to the contract
 * has no rendering until someone decides on one.
 */
export const CITATION_RELATION_DISPLAY = {
  supports: { tone: "success", label: "common.supports" },
  contradicts: { tone: "destructive", label: "docxCitationCheck.contradicts" },
  does_not_address: {
    tone: "warning",
    label: "docxCitationCheck.doesNotAddress",
  },
  // Amber, like "does not address": both are answers the writer has to go
  // and read the decision for, which is a different state from a green or a
  // red the writer can act on.
  uncertain: { tone: "warning", label: "docxCitationCheck.uncertain" },
} as const satisfies Record<
  CitationRelationReading,
  { tone: ReviewStatusTone; label: TranslationKey }
>;
