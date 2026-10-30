import type { CitationAnchorSource } from "@stll/decision-reader/reader-types";
import type { CitationSpan } from "@stll/legal-ast/citation-passage";
import type { Block } from "@stll/legal-ast/document-ast";

type CitationOccurrenceParagraph = {
  anchorId: string;
  blockId: string;
  /** The court's own number on the paragraph; null when it printed none. */
  paragraphNumber: number | null;
  /** Which mention of the decision opens the paragraph, counted from 1. */
  firstMention: number;
};

export type CitationOccurrences = {
  /** Every mention of the decision in the text, counted once per mark. */
  mentions: number;
  /** The paragraphs naming the decision, once each, in text order. */
  paragraphs: CitationOccurrenceParagraph[];
};

type CitationOccurrencesByDecisionOptions = {
  blocks: readonly Block[];
  spansByBlockId: Readonly<
    Record<string, readonly CitationSpan<CitationAnchorSource>[]>
  >;
};

/**
 * Where each cited decision is named in a decision's text, keyed by the cited
 * decision's id. Several citation rows can name one decision ("sp. zn." in
 * one sentence, "č. j." in another), so they are counted together.
 */
export const citationOccurrencesByDecision = ({
  blocks,
  spansByBlockId,
}: CitationOccurrencesByDecisionOptions): ReadonlyMap<
  string,
  CitationOccurrences
> => {
  const byDecision = new Map<string, CitationOccurrences>();
  for (const block of blocks) {
    const spans = spansByBlockId[block.id];
    if (spans === undefined) {
      continue;
    }
    for (const { source } of spans) {
      const decisionId = source.decision.id;
      let occurrences = byDecision.get(decisionId);
      if (occurrences === undefined) {
        occurrences = { mentions: 0, paragraphs: [] };
        byDecision.set(decisionId, occurrences);
      }
      occurrences.mentions += 1;
      if (occurrences.paragraphs.at(-1)?.blockId === block.id) {
        continue;
      }
      occurrences.paragraphs.push({
        anchorId: block.anchorId,
        blockId: block.id,
        paragraphNumber:
          block.type === "paragraph" && block.number !== undefined
            ? block.number
            : null,
        firstMention: occurrences.mentions,
      });
    }
  }
  return byDecision;
};
