import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  locateProvisionAnchors,
  provisionOccurrenceContexts,
} from "@/features/case-law/provision-anchors";

const paragraph = (id: string, text: string): Block => ({
  id,
  anchorId: id,
  type: "paragraph",
  inlines: [{ type: "text", text }],
  plainText: text,
});

const blocks = [
  paragraph(
    "b1",
    "1. Žalobce se domáhal zrušení rozhodnutí podle § 90 odst. 5 zákona č. 500/2004 Sb., správní řád.",
  ),
  paragraph(
    "b2",
    "2. Soud postupoval podle § 7 odst. 6 s. ř. s.; k § 7 odst. 6 srov. dále bod 4.",
  ),
  paragraph("b3", "3. Jiná věc podle § 90 správního řádu."),
];

const reference = (
  section: number,
  subsection: string | null = null,
): {
  letter: null;
  section: number;
  sectionSuffix: null;
  subsection: string | null;
  unit: "section";
} => ({
  letter: null,
  section,
  sectionSuffix: null,
  subsection,
  unit: "section",
});

describe("locateProvisionAnchors", () => {
  test("anchors the reference inside the sentence it was read from", () => {
    const { anchorsByPieceId: located } = locateProvisionAnchors({
      blocks,
      provisions: [
        {
          id: "a",
          reference: reference(90, "5"),
          sentenceText:
            "1.Žalobce se domáhal zrušení rozhodnutí podle § 90 odst. 5 zákona č. 500/2004 Sb., správní řád.",
          spanStart: 40,
          target: "sprav-rad",
        },
      ],
    });

    const span = located["b1"]?.at(0);
    expect(span).toBeDefined();
    expect(blocks[0]?.plainText.slice(span?.start, span?.end)).toBe(
      "§ 90 odst. 5",
    );
    expect(located["b3"]).toBeUndefined();
  });

  test("anchors a subsection the decision spells out", () => {
    // From 4 Tdo 348/2023, which writes "odstavec" where the rest of the
    // judgment writes "odst.". Same reference, so the anchor covers the same
    // words: an abbreviation-only matcher stopped at the section number.
    const spelledOut = paragraph(
      "b4",
      "4. Soud spatřoval naplnění znaků přečinu obecného ohrožení z nedbalosti podle § 273 odstavec 1 tr. zákoníku.",
    );
    const { anchorsByPieceId: located } = locateProvisionAnchors({
      blocks: [spelledOut],
      provisions: [
        {
          id: "a",
          reference: reference(273, "1"),
          sentenceText:
            "4. Soud spatřoval naplnění znaků přečinu obecného ohrožení z nedbalosti podle § 273 odstavec 1 tr. zákoníku.",
          spanStart: 73,
          target: "tr-zakonik",
        },
      ],
    });

    const span = located["b4"]?.at(0);
    expect(span).toBeDefined();
    expect(spelledOut.plainText.slice(span?.start, span?.end)).toBe(
      "§ 273 odstavec 1",
    );
  });

  test("anchors the Slovak spelling of a spelled-out subsection", () => {
    // Slovak writes "odsek" where Czech writes "odstavec"; both abbreviate
    // to a form the matcher already read, so only the long words differ.
    const slovak = paragraph(
      "b5",
      "5. Súd postupoval podľa § 273 odsek 1 Trestného zákona.",
    );
    const { anchorsByPieceId: located } = locateProvisionAnchors({
      blocks: [slovak],
      provisions: [
        {
          id: "a",
          reference: reference(273, "1"),
          sentenceText:
            "5. Súd postupoval podľa § 273 odsek 1 Trestného zákona.",
          spanStart: 22,
          target: "tr-zakon",
        },
      ],
    });

    const span = located["b5"]?.at(0);
    expect(span).toBeDefined();
    expect(slovak.plainText.slice(span?.start, span?.end)).toBe(
      "§ 273 odsek 1",
    );
  });

  test("distinct occurrences of one provision in a sentence each get an anchor", () => {
    const { anchorsByPieceId: located } = locateProvisionAnchors({
      blocks,
      provisions: [
        {
          id: "a",
          reference: reference(7, "6"),
          sentenceText: blocks[1]?.plainText ?? "",
          spanStart: 20,
          target: null,
        },
        {
          id: "b",
          reference: reference(7, "6"),
          sentenceText: blocks[1]?.plainText ?? "",
          spanStart: 70,
          target: null,
        },
      ],
    });

    expect(located["b2"]).toHaveLength(2);
    expect(
      located["b2"]?.map(({ end, start }) =>
        blocks[1]?.plainText.slice(start, end),
      ),
    ).toEqual(["§ 7 odst. 6", "§ 7 odst. 6"]);
  });

  test("an exact local span does not drift to the same section of another act", () => {
    const text =
      "Podle § 60 jiného zákona a podle § 60 odst. 3 s. ř. s. rozhodl soud.";
    const block = paragraph("mixed", text);
    const start = text.indexOf("§ 60 odst. 3");
    const { anchorsByPieceId: located } = locateProvisionAnchors({
      blocks: [block],
      provisions: [
        {
          exactSpan: {
            blockId: block.id,
            end: start + "§ 60 odst. 3".length,
            start,
          },
          id: "srs-60",
          reference: reference(60, "3"),
          sentenceText: text,
          spanStart: start,
          target: "srs",
        },
      ],
    });

    const span = located[block.id]?.at(0);
    expect(text.slice(span?.start, span?.end)).toBe("§ 60 odst. 3");
  });

  test("a sentence the text no longer carries anchors nowhere", () => {
    expect(
      locateProvisionAnchors({
        blocks,
        provisions: [
          {
            id: "a",
            reference: reference(7),
            sentenceText: "Tato věta v textu není.",
            spanStart: 0,
            target: null,
          },
        ],
      }),
    ).toEqual({
      anchorsByPieceId: {},
      failures: [{ id: "a", reason: "sentence-unlocatable" }],
    });
  });
});

test("unplaceable references and invalid exact spans remain accounted for", () => {
  const source = {
    id: "stored",
    reference: reference(7),
    sentenceText: blocks.at(0)?.plainText ?? "",
    spanStart: 0,
    target: null,
  };
  expect(
    locateProvisionAnchors({ blocks, provisions: [source] }).failures,
  ).toEqual([{ id: "stored", reason: "reference-unlocatable" }]);
  for (const exactSpan of [
    { blockId: "missing", start: 0, end: 1 },
    { blockId: "b1", start: -1, end: 1 },
    { blockId: "b1", start: 0, end: 0 },
    { blockId: "b1", start: 0, end: Number.MAX_SAFE_INTEGER },
  ]) {
    expect(
      locateProvisionAnchors({ blocks, provisions: [{ ...source, exactSpan }] })
        .failures,
    ).toEqual([{ id: "stored", reason: "span-out-of-bounds" }]);
  }
  const exactSpan = { blockId: "b1", start: 0, end: 1 };
  const result = locateProvisionAnchors({
    blocks,
    provisions: [
      { ...source, exactSpan },
      { ...source, id: "overlap", exactSpan },
    ],
  });
  expect(Object.values(result.anchorsByPieceId).flat()).toHaveLength(1);
  expect(result.failures).toEqual([{ id: "overlap", reason: "span-overlap" }]);
});

test("complete context distinguishes shared openings and crosses section breaks", () => {
  const opening =
    "Soud po důkladném přezkoumání všech skutečností a vzájemných souvislostí";
  const sentence = `${opening} použil § 42 odst. 4 zákona.`;
  const source = {
    id: "stored",
    reference: reference(42, "4"),
    sentenceText: sentence,
    spanStart: 0,
    target: null,
  };
  const result = locateProvisionAnchors({
    blocks: [
      paragraph("other", `${opening} použil § 42 odst. 3 jiného zákona.`),
      paragraph("start", opening),
      paragraph("end", "použil § 42 odst. 4 zákona."),
    ],
    provisions: [source],
  });
  expect(result.failures).toEqual([]);
  expect(
    result.anchorsByPieceId["end"]?.map(({ start, end }) =>
      "použil § 42 odst. 4 zákona.".slice(start, end),
    ),
  ).toEqual(["§ 42 odst. 4"]);
});

test("missing subdivisions and competing acts cannot select another occurrence", () => {
  const sentence =
    "Podle § 42 prvního zákona a § 42 druhého zákona soud rozhodl.";
  const source = {
    id: "stored",
    reference: reference(42),
    sentenceText: sentence,
    spanStart: 0,
    target: null,
  };
  expect(
    locateProvisionAnchors({
      blocks: [paragraph("text", sentence)],
      provisions: [source],
    }).failures,
  ).toEqual([{ id: "stored", reason: "ambiguous-placement" }]);
  expect(
    locateProvisionAnchors({
      blocks: [paragraph("text", sentence)],
      provisions: [{ ...source, reference: reference(42, "4") }],
    }).failures,
  ).toEqual([{ id: "stored", reason: "reference-unlocatable" }]);
  expect(
    locateProvisionAnchors({
      blocks: [paragraph("text", sentence)],
      provisions: [
        {
          ...source,
          occurrence: { ordinal: 1, count: 2, competingPatterns: [] },
        },
      ],
    }).anchorsByPieceId["text"]?.at(0)?.start,
  ).toBe(sentence.lastIndexOf("§ 42"));
});

test("more specific stored references reserve their own occurrences before section links", () => {
  for (const sentence of [
    "Podle § 42 zákona A a § 42 odst. 4 zákona B.",
    "Podle § 42 odst. 4 zákona B a § 42 zákona A.",
  ]) {
    const sources = [
      {
        id: "section",
        reference: reference(42),
        sentenceText: sentence,
        spanStart: sentence.indexOf("§ 42 zákona A"),
        target: "act-a",
      },
      {
        id: "subsection",
        reference: reference(42, "4"),
        sentenceText: sentence,
        spanStart: sentence.indexOf("§ 42 odst. 4"),
        target: "act-b",
      },
    ];
    const contexts = provisionOccurrenceContexts(sources);
    // Unresolved targets are filtered only after every stored row contributes.
    for (const selected of [
      sources,
      sources.filter(({ id }) => id === "section"),
    ]) {
      const result = locateProvisionAnchors({
        blocks: [paragraph("text", sentence)],
        provisions: selected.map((source) => ({
          ...source,
          occurrence: contexts.get(source.id),
        })),
      });
      expect(result.failures).toEqual([]);
      expect(
        result.anchorsByPieceId["text"]?.map(({ start, end, source }) => ({
          text: sentence.slice(start, end),
          start,
          target: source.target,
        })),
      ).toEqual(
        selected
          .toSorted((left, right) => left.spanStart - right.spanStart)
          .map((source) => ({
            text: source.id === "section" ? "§ 42" : "§ 42 odst. 4",
            start: source.spanStart,
            target: source.target,
          })),
      );
    }
  }
});
