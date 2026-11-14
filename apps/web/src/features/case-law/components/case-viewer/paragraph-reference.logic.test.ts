import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import {
  PARAGRAPH_PREVIEW_CHARACTER_LIMIT,
  paragraphPreview,
  resolveParagraphReference,
} from "./paragraph-reference.logic";

const blocks = [
  {
    id: "intro",
    anchorId: "p-1",
    type: "paragraph",
    inlines: [],
    plainText: "The complainant lodged a constitutional complaint.",
  },
  {
    id: "nine",
    anchorId: "p-2",
    type: "paragraph",
    number: 9,
    inlines: [],
    plainText: "The court of appeal did not address the objection.",
  },
  {
    id: "heading",
    anchorId: "h-1",
    type: "heading",
    level: 2,
    inlines: [],
    plainText: "Assessment",
  },
  {
    id: "ten",
    anchorId: "p-3",
    type: "paragraph",
    number: 10,
    inlines: [],
    plainText: "That omission breached the right to a fair trial.",
  },
] satisfies Block[];

const resolve = (startAnchorId: string, endAnchorId: string) =>
  resolveParagraphReference({
    blocks,
    formatNumber: String,
    range: { startAnchorId, endAnchorId },
  });

describe("resolving a paragraph reference", () => {
  test("a single paragraph resolves to its number and text", () => {
    expect(resolve("p-2", "p-2")).toEqual({
      startAnchorId: "p-2",
      endAnchorId: "p-2",
      startIndex: 1,
      endIndex: 1,
      label: "[9]",
      paragraphs: [
        {
          anchorId: "p-2",
          number: "9",
          text: "The court of appeal did not address the objection.",
        },
      ],
    });
  });

  test("a range resolves to every block it covers, in reading order", () => {
    const reference = resolve("p-1", "p-3");
    expect(reference?.label).toBe("[¶1]-[10]");
    expect(reference?.paragraphs).toEqual([
      {
        anchorId: "p-1",
        number: "¶1",
        text: "The complainant lodged a constitutional complaint.",
      },
      {
        anchorId: "p-2",
        number: "9",
        text: "The court of appeal did not address the objection.",
      },
      { anchorId: "h-1", number: "¶3", text: "Assessment" },
      {
        anchorId: "p-3",
        number: "10",
        text: "That omission breached the right to a fair trial.",
      },
    ]);
  });

  test("a range with a missing end, a missing start or a backward run does not resolve", () => {
    expect(resolve("p-2", "p-99")).toBeNull();
    expect(resolve("p-99", "p-2")).toBeNull();
    expect(resolve("p-3", "p-2")).toBeNull();
  });
});

// Paragraphs around a third of the budget, so ranges both fit and overflow.
const paragraphArbitrary = fc.record({
  anchorId: fc.uuid(),
  number: fc.nat().map(String),
  text: fc.string({
    maxLength: PARAGRAPH_PREVIEW_CHARACTER_LIMIT / 3,
    unit: "grapheme",
  }),
});

describe("previewing cited paragraphs", () => {
  test("a preview shows whole paragraphs, then a prefix, within its budget", () => {
    assertProperty(
      "a preview shows whole paragraphs, then a prefix, within its budget",
      fc.property(
        fc.array(paragraphArbitrary),
        fc.integer({ min: 1, max: PARAGRAPH_PREVIEW_CHARACTER_LIMIT }),
        (paragraphs, limit) => {
          const total = paragraphs.reduce(
            (sum, { text }) => sum + text.length,
            0,
          );
          const preview = paragraphPreview(paragraphs, limit);
          expect(preview.truncated).toBe(total > limit);
          if (!preview.truncated) {
            expect(preview.paragraphs).toEqual(paragraphs);
            return;
          }
          const shown = preview.paragraphs.reduce(
            (sum, { text }) => sum + text.length,
            0,
          );
          expect(shown).toBeLessThanOrEqual(limit);
          for (const [index, paragraph] of preview.paragraphs.entries()) {
            const source = paragraphs[index];
            expect(paragraph.anchorId).toBe(source?.anchorId ?? "");
            expect(source?.text.startsWith(paragraph.text)).toBe(true);
          }
        },
      ),
    );
  });

  test("a long paragraph is cut at a word, not inside one", () => {
    const preview = paragraphPreview(
      [{ anchorId: "p-2", number: "9", text: "alpha beta gamma delta" }],
      13,
    );
    expect(preview).toEqual({
      paragraphs: [{ anchorId: "p-2", number: "9", text: "alpha beta" }],
      truncated: true,
    });
  });
});
