import { describe, expect, test } from "bun:test";

import {
  findCitationPassage,
  locateCitationSpans,
} from "./citation-passage.js";
import type { Block } from "./document-ast.js";

const paragraph = (id: string, plainText: string): Block => ({
  anchorId: id,
  id,
  inlines: [{ text: plainText, type: "text" }],
  plainText,
  type: "paragraph",
});

/** Only the text is located; a caller's own fields ride along untouched. */
const source = (id: string, citationText: string) => ({ citationText, id });

describe("locateCitationSpans", () => {
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

    const anchors = locateCitationSpans({
      blocks: [block],
      citations: [source("1", "I. ÚS 2447/13")],
    });
    const span = anchors["n"]?.at(0);
    expect(span).toBeDefined();
    expect(inlineText.slice(span?.start, span?.end)).toBe(
      "sp. zn. I. ÚS 2447/13",
    );
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

    const located = locateCitationSpans({ blocks, citations: [citation] });

    expect(Object.keys(located).toSorted()).toEqual(["a", "b"]);
    const text = blocks.at(0)?.plainText ?? "";
    // The first mention carries a prefix and the second does not; both are
    // the same case, so both are marked, each over what the text prints.
    expect(
      located["a"]?.map((span) => text.slice(span.start, span.end)),
    ).toEqual(["sp. zn. I. ÚS 2447/13", "I. ÚS 2447/13"]);
    expect(located["b"]).toHaveLength(1);
    expect(located["b"]?.at(0)?.source.id).toBe("1");
  });

  test("keeps the earlier, longer hit when mentions overlap and drops short texts", () => {
    const blocks = [
      paragraph("a", "viz sygn. akt II CSK 123/20 i II CSK 123/20"),
    ];
    const located = locateCitationSpans({
      blocks,
      citations: [
        source("short", "II"),
        source("bare", "II CSK 123/20"),
        source("prefixed", "sygn. akt II CSK 123/20"),
      ],
    });

    // Two rows for one case mark each mention once, not twice over.
    const text = blocks.at(0)?.plainText ?? "";
    expect(
      located["a"]?.map((span) => text.slice(span.start, span.end)),
    ).toEqual(["sygn. akt II CSK 123/20", "II CSK 123/20"]);
  });

  test("a short text alone in a block yields no anchor", () => {
    const blocks = [paragraph("a", "viz II a dále II.")];
    const located = locateCitationSpans({
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
    const located = locateCitationSpans({
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

  test("marks a mention the decision introduces under another prefix", () => {
    // One Czech judgment, two sentences of it: the reasoning invokes the
    // ruling with "sp. zn." and the recitals name the file with "č. j." and
    // its page, which is the spelling the extractor did not store.
    const blocks = [
      paragraph(
        "a",
        "Následně byl tento rozsudek zrušen usnesením Nejvyššího soudu ČR ze dne 30. 6. 2021, č. j. 4 Tdo 1323/2020-906, a to toliko z podnětu jeho podaného dovolání.",
      ),
      paragraph(
        "b",
        "byl následně v celém rozsahu zrušen usnesením Nejvyššího soudu ze dne 30. 6. 2021 sp. zn. 4 Tdo 1323/2020, v důsledku čehož „obživl“ výrok o vině.",
      ),
    ];
    const citation = source("1", "sp. zn. 4 Tdo 1323/2020");
    expect(blocks.at(0)?.plainText.includes(citation.citationText)).toBe(false);

    const located = locateCitationSpans({ blocks, citations: [citation] });

    expect(Object.keys(located).toSorted()).toEqual(["a", "b"]);
    const recital = blocks.at(0)?.plainText ?? "";
    expect(
      located["a"]?.map((span) => recital.slice(span.start, span.end)),
    ).toEqual(["č. j. 4 Tdo 1323/2020"]);
  });

  test("regex metacharacters in a citation are literal", () => {
    const blocks = [paragraph("a", "C-837/24 (EU:C:2026:93) and C-837/24.")];
    const located = locateCitationSpans({
      blocks,
      citations: [source("eu", "(EU:C:2026:93)")],
    });

    expect(located["a"]?.map((span) => [span.start, span.end])).toEqual([
      [9, 23],
    ]);
  });
});

describe("the paragraph a citation is read from", () => {
  test("is the only block that carries the citation", () => {
    const blocks = [
      paragraph("p1", "Úvod bez citace."),
      paragraph("p2", "Soud vyšel z rozsudku 21 Cdo 500/2019 a dovodil více."),
    ];

    const passage = findCitationPassage({
      blocks,
      citationText: "21 Cdo 500/2019",
      sectionText: undefined,
    });

    expect(passage?.anchorId).toBe("p2");
    expect(passage?.mention).toBe("sole");
    expect(passage?.text).toBe(blocks[1]?.plainText);
  });

  test("is the recorded section's own paragraph, not the document's last", () => {
    const blocks = [
      paragraph("p1", "Přehled: 21 Cdo 500/2019."),
      paragraph("p7", "K rozsudku 21 Cdo 500/2019 se senát přiklání."),
      paragraph("p9", "Od závěrů rozsudku 21 Cdo 500/2019 se senát odchyluje."),
    ];
    // The treatment was classified from the middle paragraph's section; the
    // last paragraph says the opposite, so a reader that ignored the section
    // would quote the contrary of the treatment beside it.
    expect(
      findCitationPassage({
        blocks,
        citationText: "21 Cdo 500/2019",
        sectionText: undefined,
      })?.anchorId,
    ).toBe("p9");

    const passage = findCitationPassage({
      blocks,
      citationText: "21 Cdo 500/2019",
      sectionText:
        "K rozsudku 21 Cdo 500/2019 se senát přiklání. Další věta sekce.",
    });

    expect(passage?.anchorId).toBe("p7");
    expect(passage?.mention).toBe("classified_section");
  });

  test("falls back to the last mention when no section narrows it", () => {
    const blocks = [
      paragraph("p1", "Přehled: 21 Cdo 500/2019."),
      paragraph("p9", "Od závěrů rozsudku 21 Cdo 500/2019 se senát odchyluje."),
    ];

    const passage = findCitationPassage({
      blocks,
      citationText: "21 Cdo 500/2019",
      sectionText: "Sekce, kterou tento dokument nenese.",
    });

    expect(passage?.anchorId).toBe("p9");
    expect(passage?.mention).toBe("latest_of_several");
  });

  test("is absent when no block carries the citation", () => {
    expect(
      findCitationPassage({
        blocks: [paragraph("p1", "Nic k věci.")],
        citationText: "21 Cdo 500/2019",
        sectionText: undefined,
      }),
    ).toBeNull();
  });

  test("matches a citation the publisher broke across lines", () => {
    const blockText = "Soud odkázal na rozsudek 21 Cdo 500/2019 a nic víc.";
    const citationText = "21 Cdo\n500/2019";
    // Without the whitespace-run pattern the stored spelling is not a
    // substring of the block, which is the whole reason for it.
    expect(blockText.includes(citationText)).toBe(false);

    expect(
      findCitationPassage({
        blocks: [paragraph("p3", blockText)],
        citationText,
        sectionText: undefined,
      })?.anchorId,
    ).toBe("p3");
  });

  test("is one paragraph when a single block names the case twice", () => {
    const blocks = [
      paragraph(
        "p2",
        "Rozsudek 21 Cdo 500/2019; na 21 Cdo 500/2019 soud odkázal znovu.",
      ),
    ];
    // Two occurrences, one block: counting occurrences rather than blocks
    // would report a choice of paragraph the document does not offer.
    expect(blocks).toHaveLength(1);

    expect(
      findCitationPassage({
        blocks,
        citationText: "21 Cdo 500/2019",
        sectionText: undefined,
      })?.mention,
    ).toBe("sole");
  });
});
