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

  const headingTexts = (ast: DocumentAst) =>
    ast.blocks
      .filter((block) => block.type === "heading")
      .map(({ plainText }) => plainText);

  const reasoningHeading = (): Block => ({
    id: "reasoning",
    anchorId: "reasoning",
    type: "heading",
    level: 2,
    inlines: [{ type: "text", text: "Odůvodnění" }],
    plainText: "Odůvodnění",
  });

  test("keeps a quoted verdict run out of the outline", () => {
    const ast = documentWith([
      reasoningHeading(),
      paragraph("h1", "I. Dosavadní průběh řízení"),
      paragraph(
        "intro",
        "Soud prvního stupně rozhodl rozsudkem, kterým uložil povinnost tak, že:",
      ),
      paragraph(
        "v1",
        "I. Žalovaný je povinen zaplatit žalobci částku 1 000 Kč",
      ),
      paragraph("v2", "II. Ve zbytku se žaloba zamítá"),
      paragraph("v3", "III. Žádný z účastníků nemá právo na náhradu nákladů"),
      paragraph("h2", "II. Posouzení odvolacím soudem"),
      paragraph("v4", "III. Rozsudek se mění ve výroku o nákladech"),
    ]);

    expect(headingTexts(normalizeCaseLawDecisionAst(ast))).toEqual([
      "Odůvodnění",
      "I. Dosavadní průběh řízení",
      "II. Posouzení odvolacím soudem",
    ]);
  });

  test("keeps a run after takto: out of the outline", () => {
    const ast = documentWith([
      reasoningHeading(),
      paragraph("intro", "Okresní soud rozhodl takto:"),
      paragraph("v1", "I. Návrh na zahájení řízení"),
      paragraph("v2", "II. Podání"),
    ]);

    expect(headingTexts(normalizeCaseLawDecisionAst(ast))).toEqual([
      "Odůvodnění",
    ]);
  });
});
