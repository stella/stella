/**
 * Finding a court-decision reference in text the writer selected or is
 * writing, the sentence it stands in, and how the answer reads.
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
 * A sentence ends at `.`, `!` or `?` closing a word of at least four letters
 * or a number of at least two digits, when what follows starts a new one: a
 * space and a capital, or the end of the paragraph.
 *
 * Deliberately not any one language's punctuation rules. What is being kept
 * out is the abbreviation: `sp. zn. Pl. ÚS 27/09` is four full stops a
 * capital follows, and a splitter that reads them as sentence ends sends half
 * an identifier as the claim. An abbreviation is a short token in every
 * language that writes one, while a year or a docket ending a sentence is
 * not, which is what the two lengths separate. The rule fails by not
 * splitting, so a sentence closing on `art. 5.` joins the next one and the
 * claim is wider than it had to be.
 */
const SENTENCE_BOUNDARY = /(?<=\p{L}{4}|\d{2})[.!?]+(?=\s+\p{Lu}|\s*$)/gu;

/**
 * The sentence of `text` that names `reference`, as the writer typed it.
 *
 * A boundary inside the reference is not a boundary: `Pl. ÚS 27/09` carries a
 * full stop that a capital follows, and splitting there would send half an
 * identifier as the claim. The whole paragraph is the answer when it holds no
 * boundary outside the reference.
 */
export const sentenceContaining = (text: string, reference: string): string => {
  const referenceStart = text.indexOf(reference);
  if (referenceStart === -1) {
    return text.trim();
  }
  const referenceEnd = referenceStart + reference.length;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(SENTENCE_BOUNDARY)) {
    const boundaryEnd = match.index + match[0].length;
    if (boundaryEnd <= referenceStart) {
      start = boundaryEnd;
      continue;
    }
    if (match.index >= referenceEnd) {
      end = boundaryEnd;
      break;
    }
  }
  return text.slice(start, end).trim();
};

/**
 * What makes two checks the same check: the reference and the sentence it
 * stands in, with runs of whitespace flattened so re-wrapping a line is not a
 * new claim. NUL joins them because no document text carries one.
 */
export const citationCheckKey = ({
  citation,
  claim,
}: {
  citation: string;
  claim: string;
}): string => `${citation}\u0000${claim.replace(/\s+/gu, " ").trim()}`;

/** Why an automatic check did not run, when it did not. */
type AutomaticCitationCheckSkip = "no_reference" | "already_checked";

export type AutomaticCitationCheckDecision =
  | { type: "run"; citation: string; claim: string; key: string }
  | { type: "skip"; reason: AutomaticCitationCheckSkip };

/**
 * Whether the paragraph the caret rests in has something to check.
 *
 * Asked once the writing there has settled, never per keystroke. `checked`
 * holds the keys this editor session has already asked about, so a caret
 * returning to a paragraph, or an edit to one of its other sentences, asks
 * nothing again: only a changed reference, or a change to the sentence around
 * it, is a new question.
 */
export const decideAutomaticCitationCheck = ({
  checked,
  paragraphText,
}: {
  checked: ReadonlySet<string>;
  paragraphText: string;
}): AutomaticCitationCheckDecision => {
  const citation = findDecisionReference(paragraphText);
  if (citation === null) {
    return { type: "skip", reason: "no_reference" };
  }
  const claim = sentenceContaining(paragraphText, citation);
  const key = citationCheckKey({ citation, claim });
  if (checked.has(key)) {
    return { type: "skip", reason: "already_checked" };
  }
  return { type: "run", citation, claim, key };
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
