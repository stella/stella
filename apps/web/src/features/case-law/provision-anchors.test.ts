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

  test("two references to one provision in one sentence anchor once each", () => {
    const located = locateProvisionAnchors({
      blocks,
      provisions: [
        {
          id: "a",
          reference: reference(7, "6"),
          sentenceText: "2. Soud postupoval podle § 7 odst. 6 s. ř. s.; k § 7",
          target: null,
        },
        {
          id: "b",
          reference: reference(7, "6"),
          sentenceText: "2. Soud postupoval podle § 7 odst. 6 s. ř. s.; k § 7",
          target: null,
        },
      ],
    });

    // Both rows find the same first occurrence; the overlap keeps one link.
    expect(located["b2"]).toHaveLength(1);
    expect(blocks[1]?.plainText.slice(located["b2"]?.[0]?.start)).toStartWith(
      "§ 7 odst. 6",
    );
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
            target: null,
          },
        ],
      }),
    ).toEqual({});
  });
});
