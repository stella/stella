import { expect, test } from "bun:test";

import {
  decisionOutline,
  locateDecisionBlocks,
} from "@/api/mcp/case-law-decision-outline";

test("every outline entry addresses its heading in the served text", () => {
  const text =
    "Preamble\n\nI. Průběh řízení\nSome text.\n\nIV. Důvodnost dovolání\n[42] Námitka.";
  const outline = decisionOutline({
    text,
    blocks: [
      { type: "heading", plainText: "I. Průběh řízení", anchorId: "h-1" },
      { type: "heading", plainText: "IV. Důvodnost dovolání", anchorId: "h-2" },
      {
        type: "paragraph",
        plainText: "[42] Námitka.",
        anchorId: "p-3",
        number: 42,
      },
      { type: "heading", plainText: "Absent heading", anchorId: "h-4" },
    ],
  });
  expect(outline.map(({ title }) => title)).toEqual([
    "I. Průběh řízení",
    "IV. Důvodnost dovolání",
    "[42] Námitka.",
  ]);
  for (const { title, start } of outline) {
    expect(text.slice(start)).toStartWith(title);
  }
  // A numbered paragraph found in the plain text takes the fragment of the
  // block it sits in, so it deep-links like a heading does.
  expect(outline.map(({ anchorId }) => anchorId)).toEqual([
    "h-1",
    "h-2",
    "p-3",
  ]);
  expect(outline.map(({ number }) => number)).toEqual([
    undefined,
    undefined,
    42,
  ]);
});

test("a plain-text outline carries no fragment", () => {
  const outline = decisionOutline({ blocks: null, text: "1. Facts\n2. Law" });
  expect(outline).toEqual([
    { anchorId: null, start: 0, title: "1. Facts" },
    { anchorId: null, start: 9, title: "2. Law" },
  ]);
});

test("located blocks skip what the served text does not hold", () => {
  expect(
    locateDecisionBlocks(
      [
        { type: "paragraph", plainText: "One.", anchorId: "p-1" },
        { type: "paragraph", plainText: "" },
        { type: "paragraph", plainText: "Missing." },
        { type: "paragraph", plainText: "Two." },
      ],
      "One.\n\nTwo.",
    ),
  ).toEqual([
    { anchorId: "p-1", end: 4, start: 0, text: "One.", type: "paragraph" },
    { anchorId: null, end: 10, start: 6, text: "Two.", type: "paragraph" },
  ]);
});

test("outline size and titles are bounded for numbered reasoning", () => {
  const text = Array.from(
    { length: 150 },
    (_, index) => `${index + 1}. ${"a".repeat(250)}`,
  ).join("\n");
  const outline = decisionOutline({ blocks: null, text });
  expect(outline).toHaveLength(100);
  expect(outline.every(({ title }) => title.length <= 80)).toBe(true);
});

test("a truncated outline title keeps supplementary characters whole", () => {
  const text = `1. ${"a".repeat(76)}𠮷 remaining text`;
  const title = decisionOutline({ blocks: null, text }).at(0)?.title;
  expect(title).toBe(`1. ${"a".repeat(76)}`);
});
