import { describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  isDocumentAst,
  persistedDocumentAstSchema,
} from "@stll/legal-ast/document-ast";

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
  test("stores a canonical AST unchanged, so its content hash and extra fields survive", () => {
    const ast = { ...decisionAst(), parserExtra: { kept: true } };
    const keysBefore = JSON.stringify(ast);
    const prepared = prepareCorpusAst({
      fallbackText: "Decision text.",
      ast,
      source: "synthetic",
    }).unwrap();
    expect(prepared.type).toBe("readable");
    expect(prepared.ast).toBe(ast);
    expect(JSON.stringify(prepared.ast)).toBe(keysBefore);
  });

  test("preserves readable ASTs and explicit absent shapes", () => {
    const ast = decisionAst();
    expect(v.safeParse(persistedDocumentAstSchema, ast).success).toBe(true);
    expect(
      prepareCorpusAst({ fallbackText: "Decision text.", ast }).unwrap(),
    ).toEqual({ type: "readable", ast });
    for (const absent of [null, EMPTY_AST]) {
      expect(
        prepareCorpusAst({
          fallbackText: "Decision text.",
          ast: absent,
        }).unwrap(),
      ).toEqual({
        type: "readable",
        ast: absent,
      });
    }
  });

  test("repairs duplicate ids and anchors through the shared preparation owner", () => {
    const report = spyOn(logger, "error");
    try {
      for (const identity of ["id", "anchorId"] as const) {
        const ast = decisionAst();
        const first = ast.blocks.at(0) ?? expect.unreachable();
        const second = ast.blocks.at(1) ?? expect.unreachable();
        second[identity] = first[identity];
        expect(v.safeParse(persistedDocumentAstSchema, ast).success).toBe(true);
        const prepared = prepareCorpusAst({
          ast,
          fallbackText: "Decision text.",
          source: "sk-courts",
          parserVersion: 20,
        }).unwrap();
        expect(prepared.type).toBe("readable");
        if (!isDocumentAst(prepared.ast)) {
          expect.unreachable("Repaired structure remains a document");
        }
        expect(prepared.ast.blocks.map((block) => block.plainText)).toEqual(
          ast.blocks.map((block) => block.plainText),
        );
        expect(
          new Set(prepared.ast.blocks.map((block) => block[identity])).size,
        ).toBe(ast.blocks.length);
        expect(report).not.toHaveBeenCalled();
      }
    } finally {
      report.mockRestore();
    }
  });

  test("stores head matter after body and reports the typed degradation", () => {
    const report = spyOn(logger, "warn");
    try {
      const ast = decisionAst();
      const late = ast.blocks.at(1) ?? expect.unreachable();
      const invalid = {
        ...ast,
        blocks: [
          ast.blocks.at(0) ?? expect.unreachable(),
          { ...late, role: "apparatus" },
        ],
      };
      const prepared = prepareCorpusAst({
        ast: invalid,
        fallbackText: "Decision text.",
        source: "synthetic",
        parserVersion: 1,
      }).unwrap();
      expect(prepared.type).toBe("readable");
      if (prepared.ast === null || !("blocks" in prepared.ast)) {
        expect.unreachable("Late head matter remains a readable document");
      }
      expect(prepared.ast.blocks.map(({ id }) => id)).toEqual(["p1", "p2"]);
      const storedLate = prepared.ast.blocks.at(1);
      expect(storedLate?.type).toBe("paragraph");
      if (storedLate?.type !== "paragraph") {
        expect.unreachable("Late fixture remains a paragraph");
      }
      expect(storedLate.role).toBe("apparatus");
      expect(report).toHaveBeenLastCalledWith(
        "case_law.ingestion.ast_head_matter_order",
        expect.objectContaining({
          source: "synthetic",
          parserVersion: 1,
          lateBlockCount: 1,
        }),
      );
    } finally {
      report.mockRestore();
    }
  });

  test("stores late head matter unchanged, so its extra fields survive", () => {
    const report = spyOn(logger, "warn");
    try {
      const ast = decisionAst();
      const late = ast.blocks.at(1) ?? expect.unreachable();
      const stored = {
        ...ast,
        parserExtra: { kept: true },
        blocks: [
          ast.blocks.at(0) ?? expect.unreachable(),
          { ...late, role: "apparatus" },
        ],
      };
      const keysBefore = JSON.stringify(stored);
      const prepared = prepareCorpusAst({
        ast: stored,
        fallbackText: "Decision text.",
        source: "synthetic",
      }).unwrap();
      expect(prepared.ast).toBe(stored);
      expect(JSON.stringify(prepared.ast)).toBe(keysBefore);
    } finally {
      report.mockRestore();
    }
  });

  test("reports validator kinds without rejected document values", () => {
    const report = spyOn(logger, "error");
    try {
      const ast = decisionAst();
      const invalid = { ...ast, version: "synthetic rejected value" };
      expect(
        prepareCorpusAst({
          fallbackText: "Decision text.",
          ast: invalid,
          parserVersion: 18,
        }).unwrap(),
      ).toEqual({
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
