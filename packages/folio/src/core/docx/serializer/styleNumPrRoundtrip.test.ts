import { describe, expect, test } from "bun:test";

import { toProseDoc } from "../../prosemirror/conversion/toProseDoc";
import type { Document, ParagraphFormatting } from "../../types/document";
import { serializeParagraphFormatting } from "./paragraphSerializer";

describe("serializeParagraphFormatting style-sourced numPr (#765)", () => {
  test("a style-sourced numPr serializes no direct <w:numPr>", () => {
    const formatting: ParagraphFormatting = {
      styleId: "AppBody-Claim",
      numPr: { numId: 2 },
      numPrFromStyle: { numId: 2 },
    };
    const xml = serializeParagraphFormatting(formatting);
    expect(xml).not.toContain("<w:numPr>");
    expect(xml).toContain('<w:pStyle w:val="AppBody-Claim"/>');
  });

  test("a diverged numPr (user changed numbering) still serializes <w:numPr>", () => {
    const formatting: ParagraphFormatting = {
      styleId: "AppBody-Claim",
      numPr: { numId: 5, ilvl: 0 },
      numPrFromStyle: { numId: 2 },
    };
    const xml = serializeParagraphFormatting(formatting);
    expect(xml).toContain("<w:numPr>");
    expect(xml).toContain('<w:numId w:val="5"/>');
  });

  test("a direct numPr with no provenance serializes <w:numPr>", () => {
    const formatting: ParagraphFormatting = {
      numPr: { numId: 2, ilvl: 0 },
    };
    const xml = serializeParagraphFormatting(formatting);
    expect(xml).toContain("<w:numPr>");
  });
});

// toProseDoc load-side: a paragraph that removes the style's numbering
// (direct numId=0 under a numbered style) drops the style's hanging slot too
// and keeps only the indent it states itself.
const STYLE_DEFS = {
  styles: [
    {
      styleId: "Numbered",
      type: "paragraph" as const,
      pPr: {
        numPr: { numId: 1 },
        indentLeft: 357,
        indentFirstLine: -357,
        hangingIndent: true,
      },
    },
  ],
};

function pmAttrsFor(formatting: ParagraphFormatting): Record<string, unknown> {
  const document: Document = {
    package: {
      document: {
        content: [{ type: "paragraph", content: [], formatting }],
      },
    },
  };
  const pmDoc = toProseDoc(document, { styles: STYLE_DEFS });
  let attrs: Record<string, unknown> = {};
  pmDoc.descendants((node) => {
    if (node.type.name === "paragraph") {
      attrs = node.attrs;
    }
    return false;
  });
  return attrs;
}

describe("style vs direct w:ind merge in toProseDoc (#765)", () => {
  test("removing style numbering (numId 0) drops the style hanging too", () => {
    const attrs = pmAttrsFor({
      styleId: "Numbered",
      numPr: { numId: 0, ilvl: 0 },
      indentLeft: 357,
    });
    expect(attrs["indentLeft"]).toBe(357);
    expect(attrs["indentFirstLine"] ?? null).toBeNull();
    expect(attrs["hangingIndent"] ?? false).toBe(false);
  });

  test("a numbered style without a direct numId keeps the style hanging", () => {
    const attrs = pmAttrsFor({ styleId: "Numbered" });
    expect(attrs["indentLeft"]).toBe(357);
    expect(attrs["indentFirstLine"]).toBe(-357);
    expect(attrs["hangingIndent"]).toBe(true);
    // The style-sourced numPr is projected with provenance.
    expect(attrs["numPr"]).toEqual({ numId: 1 });
    expect(attrs["numPrFromStyle"]).toEqual({ numId: 1 });
  });
});
