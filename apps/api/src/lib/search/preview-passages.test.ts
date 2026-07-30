import { describe, expect, test } from "bun:test";

import {
  buildSearchPreviewPassages,
  SEARCH_PREVIEW_PASSAGE_OVERLAP,
  SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT,
} from "@/api/lib/search/preview-passages";

const codePoints = (text: string): string[] => Array.from(text);

describe("search preview passages", () => {
  test("every accepted query-sized source span is contained in a passage", () => {
    const body = `${"a".repeat(49_300)}${"🧑🏽‍⚖️".repeat(300)}${"b".repeat(50_000)}`;
    const bodyPoints = codePoints(body);
    const passages = buildSearchPreviewPassages("Title", body);

    for (const passage of passages) {
      expect(codePoints(passage.content).length).toBeLessThanOrEqual(
        SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT,
      );
    }

    for (let start = 0; start < bodyPoints.length; start += 97) {
      const span = bodyPoints
        .slice(start, start + SEARCH_PREVIEW_PASSAGE_OVERLAP)
        .join("");
      expect(passages.some(({ content }) => content.includes(span))).toBe(true);
    }
  });

  test("is deterministic and always emits ordinal zero", () => {
    const first = buildSearchPreviewPassages("Matter", "");
    expect(first).toEqual([{ content: "Matter ", ordinal: 0 }]);
    expect(buildSearchPreviewPassages("Matter", "")).toEqual(first);
  });

  test("repeats the title so title-only matches select ordinal zero", () => {
    const passages = buildSearchPreviewPassages(
      "Unique title",
      "body ".repeat(30_000),
    );

    expect(passages.length).toBeGreaterThan(1);
    for (const [ordinal, passage] of passages.entries()) {
      expect(passage.ordinal).toBe(ordinal);
      expect(passage.content.startsWith("Unique title ")).toBe(true);
    }
  });

  test("locates a passage around one million characters", () => {
    const marker = "persisted-locator-regression";
    const body = `${"x".repeat(1_000_000)} ${marker} tail`;
    const passages = buildSearchPreviewPassages("Decision", body);
    const match = passages.find(({ content }) => content.includes(marker));

    expect(match?.ordinal).toBeGreaterThan(0);
    expect(match?.content.length).toBeLessThanOrEqual(
      SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT,
    );
  });
});
