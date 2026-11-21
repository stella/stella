import { describe, expect, test } from "bun:test";

import type { DocumentAst, ParagraphBlock } from "./document-ast.js";
import { resolveDecisionParagraphRange } from "./paragraph-range.js";

const paragraph = (id: string, number?: number): ParagraphBlock => ({
  id,
  anchorId: `p-${id}`,
  type: "paragraph",
  inlines: [{ type: "text", text: id }],
  plainText: id,
  ...(number === undefined ? {} : { number }),
});

const ast = (...blocks: DocumentAst["blocks"]): DocumentAst => ({
  version: 1,
  source: { system: "", documentId: "", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

describe("decision paragraph range resolution", () => {
  test("resolves every requested court number in numeric order", () => {
    const document = ast(
      paragraph("3", 3),
      paragraph("1", 1),
      paragraph("2", 2),
    );
    expect(resolveDecisionParagraphRange(document, { from: 1, to: 3 })).toEqual(
      {
        type: "found",
        anchorIds: ["p-1", "p-2", "p-3"],
        firstAnchorId: "p-1",
      },
    );
  });

  test("requires the full inclusive range and returns every gap", () => {
    const document = ast(
      paragraph("one", 1),
      paragraph("three", 3),
      paragraph("fraction", 2.5),
      paragraph("unnumbered"),
    );
    expect(resolveDecisionParagraphRange(document, { from: 1, to: 4 })).toEqual(
      { type: "not-found", missing: [2, 4] },
    );
  });

  test("uses the first anchor when a court number is repeated", () => {
    const document = ast(
      paragraph("first", 7),
      paragraph("duplicate", 7),
      paragraph("next", 8),
    );
    expect(resolveDecisionParagraphRange(document, { from: 7, to: 8 })).toEqual(
      {
        type: "found",
        anchorIds: ["p-first", "p-next"],
        firstAnchorId: "p-first",
      },
    );
  });

  test("rejects a reversed structural range as programmer misuse", () => {
    expect(() =>
      resolveDecisionParagraphRange(ast(), { from: 2, to: 1 }),
    ).toThrow("Decision paragraph range must be a valid inclusive range");
  });
});
