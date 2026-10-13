import { expect, test } from "bun:test";

import { validateAst } from "./validate-ast";
import baseline from "./validate-ast-defaults.baseline.json";

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
