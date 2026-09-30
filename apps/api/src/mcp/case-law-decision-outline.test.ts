import { expect, test } from "bun:test";

import { decodePaginationCursor } from "@/api/lib/pagination";
import { decisionOutline } from "@/api/mcp/case-law-decision-outline";

test("every outline cursor addresses its heading in the served text", () => {
  const text =
    "Preamble\n\nI. Průběh řízení\nSome text.\n\nIV. Důvodnost dovolání\n[42] Námitka.";
  const outline = decisionOutline({
    text,
    blocks: [
      { type: "heading", plainText: "I. Průběh řízení" },
      { type: "heading", plainText: "IV. Důvodnost dovolání" },
      { type: "heading", plainText: "Absent heading" },
    ],
  });
  expect(outline.map(({ title }) => title)).toEqual([
    "I. Průběh řízení",
    "IV. Důvodnost dovolání",
    "[42] Námitka.",
  ]);
  for (const { title, cursor } of outline) {
    const offset = decodePaginationCursor(cursor)?.at(0);
    expect(typeof offset).toBe("number");
    if (typeof offset !== "number") {
      continue;
    }
    expect(text.slice(offset)).toStartWith(title);
    expect(decodePaginationCursor(cursor)?.at(1)).toBeNull();
  }
});

test("outline size and titles are bounded for numbered reasoning", () => {
  const text = Array.from(
    { length: 150 },
    (_, index) => `${index + 1}. ${"a".repeat(250)}`,
  ).join("\n");
  const outline = decisionOutline({ blocks: null, text });
  expect(outline).toHaveLength(100);
  expect(outline.every(({ title }) => title.length <= 200)).toBe(true);
});
