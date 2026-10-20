import { expect, test } from "bun:test";
import * as cheerio from "cheerio";

import type { Block } from "@stll/legal-ast/document-ast";

import { validateAst } from "./validate-ast";
import baseline from "./validate-ast-defaults.baseline.json";

test("a reused parsed document retains fresh-parse diagnostics", () => {
  const html = "<p>Alpha BRAVO Charlie</p>";
  const blocks = [
    {
      type: "paragraph" as const,
      id: "p-1",
      anchorId: "p-1",
      inlines: [{ type: "text" as const, text: "Alpha Charlie" }],
      plainText: "Alpha Charlie",
    },
  ] satisfies Block[];

  expect(validateAst(html, blocks, { document: cheerio.load(html) })).toEqual(
    validateAst(html, blocks),
  );
});

test("validation reads an explicitly supplied parsed document", () => {
  const blocks = [
    {
      type: "paragraph" as const,
      id: "p-1",
      anchorId: "p-1",
      inlines: [{ type: "text" as const, text: "Parsed document words" }],
      plainText: "Parsed document words",
    },
  ] satisfies Block[];

  const result = validateAst("<p>different source words</p>", blocks, {
    document: cheerio.load("<p>Parsed document words</p>"),
  });

  expect(result.stats.missingWords).toEqual([]);
  expect(result.stats.originalLength).toBe("Parsed document words".length);
});

// Captured by executing the validator and residue modules from 53dbd13e0a
// against invented inputs, before CourtListener-specific policies were added.
// The complete result remains the default contract for other source parsers.
for (const { name, html, headings, paragraphs, expected } of baseline.cases) {
  test(`default validation retains ${name}`, () => {
    const blocks = [
      ...headings.map((text) => ({
        type: "heading" as const,
        id: "invented-heading",
        anchorId: "invented-heading",
        level: 2 as const,
        role: "section-heading" as const,
        inlines: [{ type: "text" as const, text }],
        plainText: text,
      })),
      ...paragraphs.map(({ inlineText, plainText }) => ({
        type: "paragraph" as const,
        id: "invented-paragraph",
        anchorId: "invented-paragraph",
        inlines: [{ type: "text" as const, text: inlineText }],
        plainText,
      })),
    ];
    expect(Bun.deepEquals(validateAst(html, blocks), expected)).toBe(true);
  });
}
