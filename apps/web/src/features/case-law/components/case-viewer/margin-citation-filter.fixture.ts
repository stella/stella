/**
 * Three paragraphs of a decision and the margin cards the reader prepares
 * for them: two citations in ¶8, one in ¶9, none in ¶10.
 */

import { prepareDecisionProvisionCards } from "@stll/decision-reader/decision-text";
import type { DecisionProvisionAnchor } from "@stll/decision-reader/reader-types";
import type { Block } from "@stll/legal-ast/document-ast";

import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";

export const EIGHTH = "Soud vyšel z § 72 a z § 257 bez dalšího.";
export const NINTH = "Stěžovatel namítá porušení § 87.";
export const TENTH = "Bez jakékoli citace.";

const paragraph = (anchorId: string, number: number, text: string) =>
  ({
    type: "paragraph",
    id: anchorId,
    anchorId,
    number,
    inlines: [{ type: "text", text }],
    plainText: text,
  }) satisfies Block;

export const BLOCKS = [
  paragraph("p-8", 8, EIGHTH),
  paragraph("p-9", 9, NINTH),
  paragraph("p-10", 10, TENTH),
];

const provision = (section: number, sentenceText: string) =>
  ({
    id: `cite-${String(section)}`,
    sentenceText,
    spanStart: 0,
    reference: {
      section,
      sectionSuffix: null,
      subsection: null,
      letter: null,
      unit: "section",
    },
    target: {
      document: {
        country: "CZE",
        id: `act-${String(section)}`,
        eli: "eli/act",
        slug: null,
        versionValidFrom: null,
      },
      preview: null,
      payload: {
        documentId: `act-${String(section)}`,
        eli: "eli/act",
        jurisdiction: "CZE",
        anchorId: `par_${String(section)}`,
        provisionLabel: `§ ${String(section)}`,
        statuteTitle: "Zákon",
        versionValidFrom: null,
        versionCount: 1,
      },
    },
  }) satisfies DecisionProvisionAnchor;

/** From the producer itself, so the ranges are where the reader puts them. */
export const CARDS = prepareDecisionProvisionCards({
  blocks: BLOCKS,
  provisionAnchors: [
    provision(72, EIGHTH),
    provision(257, EIGHTH),
    provision(87, NINTH),
  ],
});

export const textOf = (anchorId: string): string =>
  BLOCKS.find((block) => block.anchorId === anchorId)?.plainText ?? "";

/** A selection of one paragraph's words, as the reader anchors it. */
export const selected = (
  blockAnchorId: string,
  startOffset: number,
  endOffset: number,
): SelectionAnchor => ({
  blockAnchorId,
  endOffset,
  quote: textOf(blockAnchorId).slice(startOffset, endOffset),
  startOffset,
});
