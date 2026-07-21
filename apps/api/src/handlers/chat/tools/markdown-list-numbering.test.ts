import { describe, expect, test } from "bun:test";

import type {
  Document as FolioDocument,
  ListRendering,
  NumberingDefinitions,
  Paragraph,
} from "@stll/docx-core/model";
import { createEmptyDocument } from "@stll/folio-core/server";

import { remapMarkdownListNumbering } from "./markdown-list-numbering";

const buildTarget = (numbering: NumberingDefinitions): FolioDocument => {
  const target = createEmptyDocument();
  target.package.numbering = numbering;
  return target;
};

// Narrower than `Paragraph`: guarantees the list-carrying fields these
// tests read back are present, so assertions need no cast/non-null
// assertion after `remapMarkdownListNumbering` mutates them in place.
type ListParagraph = Paragraph & {
  formatting: { numPr: { numId: number; ilvl: number } };
  listRendering: ListRendering;
};

const bulletParagraph = (numId: number, ilvl: number): ListParagraph => ({
  type: "paragraph",
  formatting: { numPr: { numId, ilvl } },
  listRendering: { marker: "•", level: ilvl, numId, isBullet: true },
  content: [],
});

const orderedParagraph = (
  numId: number,
  ilvl: number,
  startOverride?: number,
): ListParagraph => ({
  type: "paragraph",
  formatting: { numPr: { numId, ilvl } },
  listRendering: {
    marker: "%1.",
    level: ilvl,
    numId,
    isBullet: false,
    numFmt: "decimal",
    ...(startOverride !== undefined ? { startOverride } : {}),
  },
  content: [],
});

const plainParagraph = (): Paragraph => ({ type: "paragraph", content: [] });

describe("remapMarkdownListNumbering", () => {
  test("no-ops when content has no list paragraphs", () => {
    const target = buildTarget({ abstractNums: [], nums: [] });
    const content = [plainParagraph(), plainParagraph()];

    remapMarkdownListNumbering(target, content);

    // Unchanged: no numbering object was ever built.
    expect(target.package.numbering).toEqual({ abstractNums: [], nums: [] });
  });

  test("renumbers list numIds above the target's existing reserved range", () => {
    const target = buildTarget({
      abstractNums: [
        { abstractNumId: 1, levels: [] },
        { abstractNumId: 2, levels: [] },
      ],
      nums: [
        { numId: 1, abstractNumId: 1 },
        { numId: 5, abstractNumId: 2 },
      ],
    });
    const bullet1 = bulletParagraph(1, 0);
    const bullet2 = bulletParagraph(1, 0);
    const ordered1 = orderedParagraph(2, 0, 3);
    const content = [bullet1, bullet2, ordered1];

    remapMarkdownListNumbering(target, content);

    // New numIds start above the existing max (5), and new abstractNumIds
    // start above the existing max (2) — never colliding with the caller's
    // pre-existing reserved definitions.
    const bulletNumId = bullet1.formatting.numPr.numId;
    const orderedNumId = ordered1.formatting.numPr.numId;
    expect(bulletNumId).toBeGreaterThan(5);
    expect(orderedNumId).toBeGreaterThan(5);
    expect(orderedNumId).not.toBe(bulletNumId);
    // Both paragraphs of the same original list share the same new numId.
    expect(bullet2.formatting.numPr.numId).toBe(bulletNumId);
    // listRendering.numId is kept in sync with the remapped numPr.numId.
    expect(bullet1.listRendering.numId).toBe(bulletNumId);

    const numbering = target.package.numbering;
    expect(numbering?.abstractNums).toHaveLength(4);
    expect(numbering?.nums).toHaveLength(4);
    const newAbstractNumIds = numbering?.abstractNums
      .slice(2)
      .map((abstractNum) => abstractNum.abstractNumId);
    expect(newAbstractNumIds?.every((id) => id > 2)).toBe(true);

    const bulletAbstractNum = numbering?.abstractNums.find(
      (abstractNum) =>
        abstractNum.abstractNumId ===
        numbering.nums.find((num) => num.numId === bulletNumId)?.abstractNumId,
    );
    expect(bulletAbstractNum?.levels).toEqual([
      expect.objectContaining({ ilvl: 0, numFmt: "bullet", lvlText: "•" }),
    ]);

    const orderedAbstractNum = numbering?.abstractNums.find(
      (abstractNum) =>
        abstractNum.abstractNumId ===
        numbering.nums.find((num) => num.numId === orderedNumId)?.abstractNumId,
    );
    expect(orderedAbstractNum?.levels).toEqual([
      expect.objectContaining({
        ilvl: 0,
        start: 3,
        numFmt: "decimal",
        lvlText: "%1.",
      }),
    ]);
  });

  test("builds one level per depth used by a nested list", () => {
    const target = buildTarget({ abstractNums: [], nums: [] });
    const content = [
      bulletParagraph(1, 0),
      bulletParagraph(1, 1),
      bulletParagraph(1, 2),
    ];

    remapMarkdownListNumbering(target, content);

    const numbering = target.package.numbering;
    expect(numbering?.abstractNums).toHaveLength(1);
    expect(
      numbering?.abstractNums[0]?.levels.map((level) => level.ilvl),
    ).toEqual([0, 1, 2]);
  });
});
