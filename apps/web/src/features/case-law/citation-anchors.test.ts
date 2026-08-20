import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import { locateCitationAnchors } from "@/features/case-law/citation-anchors";
import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import { toSafeId } from "@/lib/safe-id";

const paragraph = (id: string, plainText: string): Block => ({
  anchorId: id,
  id,
  inlines: [{ text: plainText, type: "text" }],
  plainText,
  type: "paragraph",
});

const source = (id: string, citationText: string): CitationAnchorSource => ({
  citationText,
  decision: {
    caseNumber: citationText,
    country: "CZE",
    court: "Court",
    decisionDate: null,
    id: toSafeId<"caseLawDecision">(
      `00000000-0000-7000-8000-${id.padStart(12, "0")}`,
    ),
    language: "cs",
    slug: null,
  },
  id,
});

describe("locateCitationAnchors", () => {
  test("offsets follow the rendered inlines when plainText was normalised", () => {
    // The pipeline may collapse a spaced-letter run ("N Á L E Z") in
    // plainText for search while the inlines keep the source characters.
    const inlineText = "N Á L E Z sp. zn. I. ÚS 2447/13 platí.";
    const block: Block = {
      anchorId: "n",
      id: "n",
      inlines: [{ text: inlineText, type: "text" }],
      plainText: "NÁLEZ sp. zn. I. ÚS 2447/13 platí.",
      type: "paragraph",
    };
    expect(block.plainText).not.toBe(inlineText);

    const anchors = locateCitationAnchors({
      blocks: [block],
      citations: [source("1", "I. ÚS 2447/13")],
    });
    const span = anchors["n"]?.at(0);
    expect(span).toBeDefined();
    expect(inlineText.slice(span?.start, span?.end)).toBe("I. ÚS 2447/13");
  });

  test("finds every mention, tolerating wrapped whitespace, and skips tables", () => {
    const blocks: Block[] = [
      paragraph("a", "srov. nález sp. zn. I. ÚS 2447/13 a dále I. ÚS 2447/13."),
      paragraph("b", "Nález I. ÚS\n2447/13 byl překonán."),
      {
        anchorId: "t",
        id: "t",
        plainText: "I. ÚS 2447/13",
        rows: [
          [
            {
              inlines: [{ text: "I. ÚS 2447/13", type: "text" }],
              plainText: "I. ÚS 2447/13",
            },
          ],
        ],
        type: "table",
      },
    ];
    const citation = source("1", "I. ÚS 2447/13");
    // The stored text differs from the wrapped mention, so a hit on block
    // "b" proves the whitespace fold, not an exact match.
    expect(blocks.at(1)?.plainText.includes(citation.citationText)).toBe(false);

    const located = locateCitationAnchors({ blocks, citations: [citation] });

    expect(Object.keys(located).toSorted()).toEqual(["a", "b"]);
    const text = blocks.at(0)?.plainText ?? "";
    expect(located["a"]?.map((span) => [span.start, span.end])).toEqual([
      [
        text.indexOf("I. ÚS"),
        text.indexOf("I. ÚS") + citation.citationText.length,
      ],
      [
        text.lastIndexOf("I. ÚS"),
        text.lastIndexOf("I. ÚS") + citation.citationText.length,
      ],
    ]);
    expect(located["b"]).toHaveLength(1);
    expect(located["b"]?.at(0)?.source.id).toBe("1");
  });

  test("keeps the earlier, longer hit when mentions overlap and drops short texts", () => {
    const blocks = [
      paragraph("a", "viz sygn. akt II CSK 123/20 i II CSK 123/20"),
    ];
    const located = locateCitationAnchors({
      blocks,
      citations: [
        source("short", "II"),
        source("bare", "II CSK 123/20"),
        source("prefixed", "sygn. akt II CSK 123/20"),
      ],
    });

    expect(located["a"]?.map((span) => span.source.id)).toEqual([
      "prefixed",
      "bare",
    ]);
  });

  test("a short text alone in a block yields no anchor", () => {
    const blocks = [paragraph("a", "viz II a dále II.")];
    const located = locateCitationAnchors({
      blocks,
      citations: [source("short", "II")],
    });
    expect(located).toEqual({});
  });

  test("a citation does not match inside a longer reference", () => {
    const blocks = [
      paragraph(
        "a",
        "srov. II CSK 123/201 a II CSK 123/20-5, nikoli XII CSK 123/20.",
      ),
    ];
    const located = locateCitationAnchors({
      blocks,
      citations: [source("bare", "II CSK 123/20")],
    });
    // Only the middle mention: a page suffix after a dash is the same case,
    // a further digit or a leading letter is a different one.
    const text = blocks.at(0)?.plainText ?? "";
    expect(located["a"]?.map((span) => [span.start, span.end])).toEqual([
      [text.indexOf("II CSK 123/20-5"), text.indexOf("II CSK 123/20-5") + 13],
    ]);
  });

  test("regex metacharacters in a citation are literal", () => {
    const blocks = [paragraph("a", "C-837/24 (EU:C:2026:93) and C-837/24.")];
    const located = locateCitationAnchors({
      blocks,
      citations: [source("eu", "(EU:C:2026:93)")],
    });

    expect(located["a"]?.map((span) => [span.start, span.end])).toEqual([
      [9, 23],
    ]);
  });
});
