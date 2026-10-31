import { describe, expect, test } from "bun:test";

import { plainTextBlocks, readerBlocks, readerRuns } from "./decision-document";

const text = (value: string) => ({ type: "text", text: value });

describe("readerRuns", () => {
  test("carries bold and italic as emphasis and joins equal neighbours", () => {
    expect(
      readerRuns([
        text("The court "),
        { type: "bold", children: [text("annuls")] },
        text(" the "),
        { type: "link", href: "x", children: [text("judgment")] },
        { type: "italic", children: [{ type: "bold", children: [text("!")] }] },
      ]),
    ).toEqual([
      { id: "0", text: "The court ", strong: false, emphasis: false },
      { id: "1", text: "annuls", strong: true, emphasis: false },
      { id: "2", text: " the judgment", strong: false, emphasis: false },
      { id: "3", text: "!", strong: true, emphasis: true },
    ]);
  });

  test("reads a citation as its printed words and drops page anchors", () => {
    expect(
      readerRuns([
        { type: "citation", cite: "22 Cdo 1/2012", children: [text("22 Cdo")] },
        { type: "page-anchor", label: "495" },
        { type: "line-break" },
      ]),
    ).toEqual([{ id: "0", text: "22 Cdo\n", strong: false, emphasis: false }]);
  });

  test("is empty for whitespace alone", () => {
    expect(readerRuns([text("  ")])).toEqual([]);
  });
});

describe("readerBlocks", () => {
  test("keeps headings, paragraphs and tables and skips the rest", () => {
    expect(
      readerBlocks([
        { id: "h", type: "heading", level: 1, inlines: [text("Nález")] },
        {
          id: "p",
          type: "paragraph",
          number: 4,
          listDepth: 1,
          role: "quote",
          inlines: [text("Text")],
        },
        { id: "i", type: "image", src: "x" },
        {
          id: "t",
          type: "table",
          rows: [[{ inlines: [text("A")] }, { inlines: [text(" B ")] }]],
        },
        "not a block",
      ]),
    ).toEqual([
      {
        kind: "heading",
        id: "h",
        level: 1,
        runs: [{ id: "0", text: "Nález", strong: false, emphasis: false }],
      },
      {
        kind: "paragraph",
        id: "p",
        number: 4,
        depth: 1,
        quote: true,
        runs: [{ id: "0", text: "Text", strong: false, emphasis: false }],
      },
      {
        kind: "table",
        id: "t",
        rows: [
          {
            id: "t.0",
            cells: [
              { id: "t.0.0", text: "A" },
              { id: "t.0.1", text: "B" },
            ],
          },
        ],
      },
    ]);
  });
});

test("plain text parts into paragraphs at blank lines", () => {
  expect(
    plainTextBlocks("First\nline\n\n  \nSecond").map((block) =>
      block.kind === "paragraph" ? block.runs[0]?.text : null,
    ),
  ).toEqual(["First\nline", "Second"]);
});
