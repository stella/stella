import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { MAX_DECISION_PARAGRAPH_RANGE_SPAN } from "@stll/api-contract/decision-paragraph-range";
import { assertProperty } from "@stll/property-testing";

import {
  outsideSpansForBlock,
  paragraphRangeLabel,
  readParagraphRangeInput,
  scopeParagraphs,
} from "@/features/avt/paragraph-scope.logic";
import type { ParagraphScope } from "@/features/avt/paragraph-scope.logic";

/** What a reviewer may leave around the numbers and the dash. */
const space = fc.constantFrom("", " ", "  ", "\t", " ", "  ");

describe("readParagraphRangeInput", () => {
  test("any range a reviewer can type reads as the range the API takes", () => {
    assertProperty(
      "any range a reviewer can type reads as the range the API takes",
      fc.property(
        fc.nat(),
        fc.integer({ min: 0, max: MAX_DECISION_PARAGRAPH_RANGE_SPAN - 1 }),
        fc.constantFrom("-", "–"),
        space,
        space,
        (start, span, dash, before, after) => {
          const from = start + 1;
          const to = from + span;
          const typed =
            span === 0
              ? `${before}${String(from)}${after}`
              : `${before}${String(from)}${after}${dash}${before}${String(to)}${after}`;
          expect(readParagraphRangeInput(typed)).toEqual({
            type: "valid",
            paragraphs:
              span === 0 ? String(from) : `${String(from)}-${String(to)}`,
          });
        },
      ),
    );
  });

  test("a range that ends first, spans too much or is not numbers is invalid", () => {
    expect(readParagraphRangeInput("136-82")).toEqual({
      type: "invalid",
      reason: "reversed",
    });
    expect(
      readParagraphRangeInput(
        `1-${String(MAX_DECISION_PARAGRAPH_RANGE_SPAN + 1)}`,
      ),
    ).toEqual({
      type: "invalid",
      reason: "too-wide",
    });
    expect(readParagraphRangeInput("82 to 136")).toEqual({
      type: "invalid",
      reason: "garbage",
    });
    expect(readParagraphRangeInput("0")).toEqual({
      type: "invalid",
      reason: "garbage",
    });
    expect(readParagraphRangeInput("  ")).toEqual({ type: "empty" });
  });
});

const scope: ParagraphScope = {
  kind: "paragraphs",
  from: 82,
  to: 136,
  numbering: "document",
  start: { blockId: "P18", offset: 1103 },
  end: { blockId: "P32", offset: 1006 },
};

describe("what a scoped run shows", () => {
  test("the range reads as one label and is sent again as it was", () => {
    expect(paragraphRangeLabel(scope)).toBe("82–136");
    expect(paragraphRangeLabel({ from: 14, to: 14 })).toBe("14");
    expect(scopeParagraphs(scope)).toBe("82-136");
    expect(scopeParagraphs({ kind: "whole" })).toBeNull();
  });

  test("only the edges of the first and last block fall outside the range", () => {
    const text = "x".repeat(1500);
    expect(outsideSpansForBlock(scope, { blockId: "P18", text })).toEqual([
      { start: 0, end: 1103 },
    ]);
    expect(outsideSpansForBlock(scope, { blockId: "P25", text })).toEqual([]);
    expect(outsideSpansForBlock(scope, { blockId: "P32", text })).toEqual([
      { start: 1006, end: 1500 },
    ]);
    expect(
      outsideSpansForBlock(
        { ...scope, end: { blockId: "P18", offset: 1200 } },
        { blockId: "P18", text },
      ),
    ).toEqual([
      { start: 0, end: 1103 },
      { start: 1200, end: 1500 },
    ]);
    expect(
      outsideSpansForBlock({ kind: "whole" }, { blockId: "P18", text }),
    ).toEqual([]);
  });
});
