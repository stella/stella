import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import { locateProvisionAnchors } from "@/features/case-law/provision-anchors";

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
    const located = locateProvisionAnchors({
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

  test("distinct occurrences of one provision in a sentence each get an anchor", () => {
    const located = locateProvisionAnchors({
      blocks,
      provisions: [
        {
          id: "a",
          reference: reference(7, "6"),
          sentenceText: "2. Soud postupoval podle § 7 odst. 6 s. ř. s.; k § 7",
          spanStart: 20,
          target: null,
        },
        {
          id: "b",
          reference: reference(7, "6"),
          sentenceText: "2. Soud postupoval podle § 7 odst. 6 s. ř. s.; k § 7",
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
    ).toEqual({});
  });
});
