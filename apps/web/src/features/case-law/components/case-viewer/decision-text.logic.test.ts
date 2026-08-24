import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { visibleDecisionBlocks } from "@/features/case-law/components/case-viewer/decision-text.logic";

const ast = {
  version: 1,
  source: { system: "test", documentId: "1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "1 As 1/2026",
    ecli: null,
    court: "Nejvyšší správní soud",
    decisionDate: null,
    decisionType: "Rozsudek",
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "case-number",
      anchorId: "case-number",
      type: "paragraph",
      role: "case-number",
      inlines: [{ type: "text", text: "1 As 1/2026" }],
      plainText: "1 As 1/2026",
    },
    {
      id: "title",
      anchorId: "title",
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: [{ type: "text", text: "JMÉNEM REPUBLIKY" }],
      plainText: "JMÉNEM REPUBLIKY",
    },
    {
      id: "related",
      anchorId: "related",
      type: "table",
      role: "related-proceedings",
      rows: [],
      plainText: "Related proceedings",
    },
    {
      id: "body",
      anchorId: "body",
      type: "paragraph",
      inlines: [{ type: "text", text: "Body" }],
      plainText: "Body",
    },
  ],
} as const satisfies DocumentAst;

describe("visible decision blocks", () => {
  test("keeps semantic headings while removing separately rendered metadata", () => {
    expect(visibleDecisionBlocks(ast).map((block) => block.id)).toEqual([
      "title",
      "body",
    ]);
  });
});
