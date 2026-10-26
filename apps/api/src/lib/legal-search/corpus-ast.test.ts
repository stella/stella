import { describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { persistedDocumentAstSchema } from "@stll/legal-ast/document-ast";

import { prepareCorpusAst } from "@/api/lib/legal-search/corpus-ast";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import { logger } from "@/api/lib/observability/logger";

const decisionAst = () =>
  ({
    version: 1,
    source: {
      system: "synthetic",
      documentId: "synthetic",
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: null,
      ecli: null,
      court: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      {
        id: "p1",
        anchorId: "p1",
        type: "paragraph",
        inlines: [{ type: "text", text: "Synthetic decision." }],
        plainText: "Synthetic decision.",
      },
      {
        id: "p2",
        anchorId: "p2",
        type: "paragraph",
        inlines: [{ type: "text", text: "Body." }],
        plainText: "Body.",
      },
    ],
  }) satisfies DocumentAst;

describe("corpus reader schema at persistence boundaries", () => {
  test("preserves readable ASTs and explicit absent shapes", () => {
    const ast = decisionAst();
    expect(v.safeParse(persistedDocumentAstSchema, ast).success).toBe(true);
    expect(prepareCorpusAst({ ast })).toEqual({ type: "readable", ast });
    for (const absent of [null, EMPTY_AST]) {
      expect(prepareCorpusAst({ ast: absent })).toEqual({
        type: "readable",
        ast: absent,
      });
    }
  });

  test("rejects duplicate ids and anchors with actionable source and parser diagnostics", () => {
    const report = spyOn(logger, "error");
    try {
      for (const identity of ["id", "anchorId"] as const) {
        const ast = decisionAst();
        const first = ast.blocks.at(0) ?? expect.unreachable();
        const second = ast.blocks.at(1) ?? expect.unreachable();
        second[identity] = first[identity];
        expect(v.safeParse(persistedDocumentAstSchema, ast).success).toBe(
          false,
        );
        expect(
          prepareCorpusAst({ ast, source: "sk-courts", parserVersion: 18 }),
        ).toEqual({ type: "text-only", ast: EMPTY_AST });
        expect(report).toHaveBeenLastCalledWith(
          "case_law.ingestion.ast_schema_rejected",
          expect.objectContaining({
            source: "sk-courts",
            parserVersion: 18,
            checks: ["Block ids and anchorIds must be unique"],
            "error.type": "IngestedAstRejectedError",
          }),
        );
      }
    } finally {
      report.mockRestore();
    }
  });

  test("reports validator kinds without rejected document values", () => {
    const report = spyOn(logger, "error");
    try {
      const ast = decisionAst();
      const invalid = { ...ast, version: "synthetic rejected value" };
      expect(prepareCorpusAst({ ast: invalid, parserVersion: 18 })).toEqual({
        type: "text-only",
        ast: EMPTY_AST,
      });
      expect(report).toHaveBeenLastCalledWith(
        "case_law.ingestion.ast_schema_rejected",
        expect.objectContaining({
          source: "synthetic",
          parserVersion: 18,
          checks: ["union"],
        }),
      );
      expect(JSON.stringify(report.mock.calls)).not.toContain(
        "synthetic rejected value",
      );
    } finally {
      report.mockRestore();
    }
  });
});
