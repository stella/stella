import { describe, expect, test } from "bun:test";

import { normalizeCaseLawDecisionAst } from "./case-law-normalize";
import type { Block, DocumentAst } from "./document-ast";

const paragraph = (id: string, text: string): Block => ({
  id,
  anchorId: id,
  type: "paragraph",
  inlines: [{ type: "text", text }],
  plainText: text,
});

const documentWith = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "decision", webUrl: "", printUrl: "" },
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

describe("case-law read normalization", () => {
  test("matches the reader's former visible heading set over legacy samples", () => {
    const samples = [
      paragraph("before", "VII. Before reasoning"),
      {
        id: "reasoning",
        anchorId: "reasoning",
        type: "heading",
        level: 2,
        inlines: [{ type: "text", text: "O d ů v o d n ě n í :" }],
        plainText: "O d ů v o d n ě n í :",
      },
      paragraph("section", "VIII. Vlastní přezkum"),
      paragraph("subsection", "VIII. A) Tzv. data retention"),
      paragraph("mention", "Tento odstavec pouze zmiňuje slovo odůvodnění."),
    ] satisfies Block[];
    const normalized = normalizeCaseLawDecisionAst(documentWith(samples));

    expect(
      normalized.blocks
        .filter((block) => block.type === "heading")
        .map(({ anchorId }) => anchorId),
    ).toEqual(["reasoning", "section", "subsection"]);
    expect(normalized.blocks.map(({ type }) => type)).toEqual([
      "paragraph",
      "heading",
      "heading",
      "heading",
      "paragraph",
    ]);
    expect(normalizeCaseLawDecisionAst(normalized)).toBe(normalized);
  });

  test("preserves a document with only an ordinary mention", () => {
    const ast = documentWith([
      paragraph("mention", "Rozhodnutí pouze zmiňuje odůvodnění rozsudku."),
    ]);

    expect(normalizeCaseLawDecisionAst(ast)).toBe(ast);
  });
});
