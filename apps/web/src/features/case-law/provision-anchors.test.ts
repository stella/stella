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

  test("anchors a subsection the decision spells out", () => {
    // From 4 Tdo 348/2023, which writes "odstavec" where the rest of the
    // judgment writes "odst.". Same reference, so the anchor covers the same
    // words: an abbreviation-only matcher stopped at the section number.
    const spelledOut = paragraph(
      "b4",
      "4. Soud spatřoval naplnění znaků přečinu obecného ohrožení z nedbalosti podle § 273 odstavec 1 tr. zákoníku.",
    );
    const located = locateProvisionAnchors({
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
    const located = locateProvisionAnchors({
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
