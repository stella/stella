import { describe, expect, test } from "bun:test";

import { READER_ANNOTATION_QUOTE_MAX_LENGTH } from "./legal-reader-annotations";
import { parseSpot, parseSpotTarget } from "./spot";

const digest = "a".repeat(64);
const boxes = {
  version: 1 as const,
  boxes: [{ pageNumber: 2, xMin: 1, yMin: 2, xMax: 3, yMax: 4 }],
};

describe("Spot targets", () => {
  test("accepts every target variant and optional location detail", () => {
    const targets = [
      { type: "document" },
      { type: "docx-block", blockId: " paragraph-1 " },
      { type: "docx-block", blockId: "paragraph-1", start: 0, end: 4 },
      { type: "pdf-page", pageNumber: 2 },
      {
        type: "pdf-page",
        pageNumber: 2,
        start: 5,
        end: 12,
        pageTextSha256: digest,
        boundingBoxes: boxes,
      },
    ];
    for (const target of targets) {
      expect(parseSpotTarget(target).success).toBe(true);
    }
  });

  test.each([
    { type: "docx-block", blockId: "p1", start: 0 },
    { type: "docx-block", blockId: "p1", start: 2, end: 2 },
    { type: "docx-block", blockId: "p1", start: 3, end: 2 },
    { type: "docx-block", blockId: "p1", start: -1, end: 2 },
    { type: "docx-block", blockId: "p1", start: 0.5, end: 2 },
    { type: "docx-block", blockId: " " },
    { type: "pdf-page", pageNumber: 0 },
    { type: "pdf-page", pageNumber: 1.5 },
    { type: "pdf-page", pageNumber: 1, startOffset: 0 },
    { type: "pdf-page", pageNumber: 1, pageTextSha256: "A".repeat(64) },
    { type: "pdf-page", pageNumber: 1, extra: true },
  ])("refuses an invalid target: %j", (target) => {
    expect(parseSpotTarget(target).success).toBe(false);
  });

  test("accepts the existing persisted locator and claim-anchor shapes", () => {
    expect(
      parseSpotTarget({
        type: "pdf-page",
        pageNumber: 2,
        boundingBoxes: boxes,
      }).success,
    ).toBe(true);
    expect(
      parseSpotTarget({
        type: "docx-block",
        blockId: "p1",
        start: 3,
        end: 8,
      }).success,
    ).toBe(true);
  });
});

describe("Spot", () => {
  const spot = {
    entityId: "entity-1",
    fieldId: "field-1",
    target: {
      type: "pdf-page" as const,
      pageNumber: 3,
      start: 7,
      end: 12,
      pageTextSha256: digest,
    },
    quote: "words",
  };

  test("accepts a PDF mark with its page offsets and digest", () => {
    expect(parseSpot(spot).success).toBe(true);
  });

  test("accepts a null quote for document and region-only spots", () => {
    expect(
      parseSpot({ ...spot, target: { type: "document" }, quote: null }).success,
    ).toBe(true);
    expect(parseSpot({ ...spot, quote: null }).success).toBe(true);
  });

  test("refuses over-long quotes and extra keys", () => {
    expect(
      parseSpot({
        ...spot,
        quote: "x".repeat(READER_ANNOTATION_QUOTE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(parseSpot({ ...spot, extra: true }).success).toBe(false);
  });

  test("refuses empty entity and field ids", () => {
    expect(parseSpot({ ...spot, entityId: "" }).success).toBe(false);
    expect(parseSpot({ ...spot, fieldId: "" }).success).toBe(false);
  });

  test("refuses a quote whose length differs from its span", () => {
    expect(parseSpot({ ...spot, quote: "word" }).success).toBe(false);
    expect(parseSpot({ ...spot, quote: "wordss" }).success).toBe(false);
  });

  test("refuses the second offset spelling", () => {
    expect(
      parseSpot({
        ...spot,
        target: {
          type: "pdf-page",
          pageNumber: 3,
          startOffset: 7,
          endOffset: 12,
          pageTextSha256: digest,
        },
      }).success,
    ).toBe(false);
  });
});
