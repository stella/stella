import { describe, expect, test } from "bun:test";

import type { CitationAnchorSource } from "@stll/decision-reader/reader-types";
import { locateCitationSpans } from "@stll/legal-ast/citation-passage";
import type { Block } from "@stll/legal-ast/document-ast";

import { citationOccurrencesByDecision } from "./citation-occurrences.logic";

const paragraph = (id: string, text: string, number?: number): Block => ({
  anchorId: `anchor-${id}`,
  id,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
  ...(number === undefined ? {} : { number }),
});

const target = (id: string): CitationAnchorSource["decision"] => ({
  caseNumber: id,
  caseNumberType: "case-number",
  country: "CZE",
  court: "Ústavní soud",
  decisionDate: null,
  ecli: null,
  id,
  language: "cs",
  languageAlternates: null,
  slug: null,
});

const citation = (
  id: string,
  citationText: string,
  decisionId: string,
): CitationAnchorSource => ({
  citationText,
  decision: target(decisionId),
  id,
  treatment: "neutral",
});

const occurrencesOf = (
  blocks: readonly Block[],
  citations: readonly CitationAnchorSource[],
) =>
  citationOccurrencesByDecision({
    blocks,
    spansByBlockId: locateCitationSpans({ blocks, citations }),
  });

describe("where a decision's text names each cited decision", () => {
  test("counts every mention and lists each naming paragraph once, in text order", () => {
    const blocks = [
      paragraph("intro", "Stěžovatel odkazuje na sp. zn. II. ÚS 2495/26.", 4),
      paragraph("none", "Tento odstavec nic necituje.", 5),
      paragraph(
        "reasons",
        "Jak uvedl nález II. ÚS 2495/26, a znovu II. ÚS 2495/26, …",
        12,
      ),
      paragraph("closing", "Srov. též II. ÚS 2495/26."),
    ];

    const occurrences = occurrencesOf(blocks, [
      citation("row", "sp. zn. II. ÚS 2495/26", "cited"),
    ]).get("cited");

    expect(occurrences).toEqual({
      mentions: 4,
      paragraphs: [
        {
          anchorId: "anchor-intro",
          blockId: "intro",
          firstMention: 1,
          paragraphNumber: 4,
        },
        {
          anchorId: "anchor-reasons",
          blockId: "reasons",
          firstMention: 2,
          paragraphNumber: 12,
        },
        {
          anchorId: "anchor-closing",
          blockId: "closing",
          firstMention: 4,
          paragraphNumber: null,
        },
      ],
    });
  });

  test("counts two citation rows naming one decision together, and keeps other decisions apart", () => {
    const blocks = [
      paragraph(
        "first",
        "Viz sp. zn. 4 Tdo 1323/2020 a usnesení III. ÚS 100/24.",
        1,
      ),
      paragraph("second", "Spis č. j. 4 Tdo 1323/2020-906 to potvrzuje.", 2),
    ];

    const occurrences = occurrencesOf(blocks, [
      citation("by-file", "č. j. 4 Tdo 1323/2020-906", "supreme"),
      citation("by-case", "sp. zn. 4 Tdo 1323/2020", "supreme"),
      citation("other", "III. ÚS 100/24", "constitutional"),
    ]);

    expect(occurrences.get("supreme")?.mentions).toBe(2);
    expect(
      occurrences.get("supreme")?.paragraphs.map(({ blockId }) => blockId),
    ).toEqual(["first", "second"]);
    expect(occurrences.get("constitutional")).toEqual({
      mentions: 1,
      paragraphs: [
        {
          anchorId: "anchor-first",
          blockId: "first",
          firstMention: 1,
          paragraphNumber: 1,
        },
      ],
    });
  });
});
