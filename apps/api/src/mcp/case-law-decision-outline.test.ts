import { expect, test } from "bun:test";

import type { Block, HeadingLevel } from "@stll/legal-ast/document-ast";

import {
  decisionOutline,
  locateDecisionBlocks,
} from "@/api/mcp/case-law-decision-outline";

const heading = (
  plainText: string,
  anchorId: string,
  level: HeadingLevel = 1,
): Block => ({
  type: "heading",
  id: anchorId,
  anchorId,
  inlines: [],
  plainText,
  level,
});
const paragraph = (
  plainText: string,
  anchorId: string,
  number?: number,
): Block => ({
  type: "paragraph",
  id: anchorId,
  anchorId,
  inlines: [],
  plainText,
  ...(number === undefined ? {} : { number }),
});

test("every outline entry addresses its heading in the served text", () => {
  const text =
    "Preamble\n\nI. Průběh řízení\nSome text.\n\nIV. Důvodnost dovolání\n[42] Námitka.";
  const { entries: outline } = decisionOutline({
    text,
    blocks: [
      heading("I. Průběh řízení", "h-1"),
      heading("IV. Důvodnost dovolání", "h-2"),
      paragraph("[42] Námitka.", "p-3", 42),
      heading("Absent heading", "h-4"),
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
  const { entries: outline } = decisionOutline({
    blocks: null,
    text: "1. Facts\n2. Law",
  });
  expect(outline).toEqual([
    { anchorId: null, start: 0, title: "1. Facts" },
    { anchorId: null, start: 9, title: "2. Law" },
  ]);
});

test("located blocks skip what the served text does not hold", () => {
  expect(
    locateDecisionBlocks(
      [
        paragraph("One.", "p-1"),
        paragraph("", "p-empty"),
        paragraph("Missing.", "p-missing"),
        paragraph("Two.", "p-2"),
      ],
      "One.\n\nTwo.",
    ),
  ).toEqual([
    {
      anchorId: "p-1",
      end: 4,
      start: 0,
      text: "One.",
      type: "paragraph",
      headingPath: [],
      label: null,
    },
    {
      anchorId: "p-2",
      end: 10,
      start: 6,
      text: "Two.",
      type: "paragraph",
      headingPath: [],
      label: null,
    },
  ]);
});

test("outline size and titles are bounded for numbered reasoning", () => {
  const text = Array.from(
    { length: 150 },
    (_, index) => `${index + 1}. ${"a".repeat(250)}`,
  ).join("\n");
  const { entries: outline } = decisionOutline({ blocks: null, text });
  expect(outline).toHaveLength(100);
  expect(outline.every(({ title }) => title.length <= 80)).toBe(true);
});

test("a truncated outline title keeps supplementary characters whole", () => {
  const text = `1. ${"a".repeat(76)}𠮷 remaining text`;
  const title = decisionOutline({ blocks: null, text }).entries.at(0)?.title;
  expect(title).toBe(`1. ${"a".repeat(76)}`);
});

test("every AST heading survives the navigation limit with its verbatim title", () => {
  const titles = Array.from(
    { length: 110 },
    (_, index) => `${index}. ${"Heading ".repeat(20)}`,
  );
  const blocks = titles.map((title, index) => heading(title, `h-${index}`));
  const dissent = "Odlišné stanovisko soudce X";
  blocks.push(heading(dissent, "dissent"));
  const text = [...titles, dissent, "[23] numbered reasoning"].join("\n");
  const outline = decisionOutline({ blocks, text });
  expect(outline.entries.map(({ title }) => title)).toEqual([
    ...titles,
    dissent,
  ]);
  expect(outline.numberedEntriesTruncated).toBe(true);
});

test("numbered navigation cannot replace or shorten a spaced AST heading", () => {
  const title = `  II. ${"Posouzení věci ".repeat(10)}`;
  const outline = decisionOutline({
    blocks: [heading(title, "h")],
    text: title,
  });
  expect(outline.entries).toEqual([{ anchorId: "h", start: 0, title }]);
});
