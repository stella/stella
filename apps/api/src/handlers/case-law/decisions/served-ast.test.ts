import { describe, expect, test } from "bun:test";

import { headingPathsByAnchor } from "@stll/legal-ast";
import type {
  DecisionDocumentAst,
  DocumentAst,
} from "@stll/legal-ast/document-ast";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { projectionDigest } from "@stll/legal-ast/projection-digest";

import {
  readServedDecisionAst,
  transientDecisionAstProjection,
} from "@/api/handlers/case-law/decisions/served-ast";
import { createSafeId } from "@/api/lib/branded-types";
import { readPersistedCorpusAst } from "@/api/lib/legal-search/corpus-storage";
import { decisionOutline } from "@/api/mcp/case-law-decision-outline";

const ast = (text: string): DecisionDocumentAst => ({
  version: 1,
  source: {
    system: "test",
    documentId: "decision",
    webUrl: "https://example.test/decision",
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
      id: "paragraph-1",
      anchorId: "p-1",
      type: "paragraph",
      inlines: [{ type: "text", text }],
      plainText: text,
    },
  ],
});

const decisionId = createSafeId<"caseLawDecision">();

describe("served decision AST projection", () => {
  test("store wins over a disagreeing row and hashes the served content", async () => {
    const stored = ast("store text");
    const row = ast("row text");
    const served = await readServedDecisionAst({
      astS3Key: "ast-key",
      contentHash: "content-hash",
      pgAst: row,
      decisionId,
      corpusReadEnabled: true,
      readStore: async () => ({ type: "read", ast: stored }),
    });

    expect(served.source).toBe("store");
    expect(served.payload).toEqual(stored);
    expect(served.projectionDigest).toBe(await projectionDigest(stored));
    expect(served.projectionDigest).not.toBe(await projectionDigest(row));
  });

  test("a failed store read reports the row that served instead", async () => {
    const row = ast("row text");
    const served = await readServedDecisionAst({
      astS3Key: "ast-key",
      contentHash: "content-hash",
      pgAst: row,
      decisionId,
      corpusReadEnabled: true,
      readStore: async () => {
        throw new Error("store unavailable");
      },
    });

    expect(served.source).toBe("row");
    expect(served.payload).toEqual(row);
    expect(served.projectionDigest).toBe(await projectionDigest(row));
  });

  test("promotes legacy section titles before serving outlines and paths", async () => {
    const row = ast("O d ů v o d n ě n í :");
    row.blocks = [
      {
        id: "paragraph-1",
        anchorId: "p-1",
        type: "heading",
        level: 2,
        inlines: [{ type: "text", text: "O d ů v o d n ě n í :" }],
        plainText: "O d ů v o d n ě n í :",
      },
      {
        id: "section",
        anchorId: "section",
        type: "paragraph",
        inlines: [{ type: "text", text: "VIII. Vlastní přezkum" }],
        plainText: "VIII. Vlastní přezkum",
      },
      {
        id: "body",
        anchorId: "body",
        type: "paragraph",
        inlines: [{ type: "text", text: "Text odůvodnění." }],
        plainText: "Text odůvodnění.",
      },
    ];
    const served = await readServedDecisionAst({
      astS3Key: null,
      contentHash: null,
      pgAst: row,
      decisionId,
      corpusReadEnabled: false,
      readStore: async () => ({ type: "read", ast: null }),
    });
    if (served.payload === null || !("blocks" in served.payload)) {
      throw new Error("Expected a served document AST");
    }

    expect(served.payload.blocks.map(({ type }) => type)).toEqual([
      "heading",
      "heading",
      "paragraph",
    ]);
    expect(
      decisionOutline({
        blocks: served.payload.blocks,
        text: served.payload.blocks
          .map(({ plainText }) => plainText)
          .join("\n"),
      }).entries.map(({ title }) => title),
    ).toEqual(["O d ů v o d n ě n í :", "VIII. Vlastní přezkum"]);
    expect(headingPathsByAnchor(served.payload.blocks).get("body")).toEqual([
      { anchorId: "p-1", title: "O d ů v o d n ě n í :" },
      { anchorId: "section", title: "VIII. Vlastní přezkum" },
    ]);
  });

  test("a missing AST has no digest or source", async () => {
    const served = await readServedDecisionAst({
      astS3Key: null,
      contentHash: null,
      pgAst: null,
      decisionId,
      corpusReadEnabled: true,
      readStore: async () => ({ type: "read", ast: ast("not read") }),
    });

    expect(served).toEqual({
      payload: null,
      source: null,
      projectionDigest: null,
      unreadable: false,
    });
  });

  test("a stored title set over two lines, both keyed as the title, is served re-keyed", async () => {
    const titleLine = (id: string, text: string) => ({
      id,
      anchorId: "h-title",
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: [{ type: "text", text }],
    });
    const row = {
      ...ast("Body."),
      blocks: [
        titleLine("b1", "ROZSUDOK V MENE"),
        titleLine("b2", "SLOVENSKEJ REPUBLIKY"),
        ...ast("Body.").blocks,
      ],
    };
    for (const corpusReadEnabled of [false, true]) {
      const served = await readServedDecisionAst({
        astS3Key: "ast-key",
        contentHash: "content-hash",
        pgAst: row,
        decisionId,
        corpusReadEnabled,
        readStore: async () => readPersistedCorpusAst(row),
      });
      if (served.payload === null || !("blocks" in served.payload)) {
        throw new Error("Expected a served document AST");
      }
      expect(served.unreadable).toBe(false);
      expect(served.payload.blocks.map(({ anchorId }) => anchorId)).toEqual([
        "h-title",
        "h-title-2",
        "p-1",
      ]);
    }
  });

  test("a row AST no reader can read is served as unreadable, not thrown", async () => {
    const malformed = {
      version: 1,
      blocks: [{ id: "p", anchorId: "p", type: "paragraph" }],
    };
    for (const corpusReadEnabled of [false, true]) {
      const served = await readServedDecisionAst({
        astS3Key: corpusReadEnabled ? "ast-key" : null,
        contentHash: corpusReadEnabled ? "content-hash" : null,
        pgAst: malformed,
        decisionId,
        corpusReadEnabled,
        readStore: async () => readPersistedCorpusAst(malformed),
      });
      expect(served).toEqual({
        payload: null,
        source: null,
        projectionDigest: null,
        unreadable: true,
      });
    }
  });

  test("an unreadable store copy falls back to a readable row", async () => {
    const row = ast("row text");
    const served = await readServedDecisionAst({
      astS3Key: "ast-key",
      contentHash: "content-hash",
      pgAst: row,
      decisionId,
      corpusReadEnabled: true,
      readStore: async () => readPersistedCorpusAst({ version: 1 }),
    });

    expect(served.source).toBe("row");
    expect(served.payload).toEqual(row);
    expect(served.unreadable).toBe(false);
  });

  test("an unreadable store copy with no row copy is unreadable, not an outage", async () => {
    const served = await readServedDecisionAst({
      astS3Key: "ast-key",
      contentHash: "content-hash",
      pgAst: null,
      decisionId,
      corpusReadEnabled: true,
      readStore: async () => readPersistedCorpusAst({ version: 1 }),
    });

    expect(served).toEqual({
      payload: null,
      source: null,
      projectionDigest: null,
      unreadable: true,
    });
  });

  test("an empty or blockless row copy recovers nothing from an unreadable store copy", async () => {
    const unreadableStore = {
      version: 1,
      blocks: [{ id: "p", anchorId: "p", type: "paragraph" }],
    };
    for (const pgAst of [{}, { ...ast("unused"), blocks: [] }]) {
      const served = await readServedDecisionAst({
        astS3Key: "ast-key",
        contentHash: "content-hash",
        pgAst,
        decisionId,
        corpusReadEnabled: true,
        readStore: async () => readPersistedCorpusAst(unreadableStore),
      });

      expect(served).toEqual({
        payload: null,
        source: null,
        projectionDigest: null,
        unreadable: true,
      });
    }
  });

  test("changes outside projected pieces keep the digest stable", async () => {
    const row = ast("same text");
    const changed = {
      ...row,
      metadata: { ...row.metadata, caseNumber: "Another label" },
      blocks: row.blocks.map((block) =>
        block.type === "paragraph"
          ? { ...block, plainText: "stale cache" }
          : block,
      ),
    } satisfies DocumentAst;
    const serve = async (pgAst: DocumentAst) =>
      await readServedDecisionAst({
        astS3Key: null,
        contentHash: null,
        pgAst,
        decisionId,
        corpusReadEnabled: false,
        readStore: async () => ({ type: "read", ast: null }),
      });

    expect((await serve(changed)).projectionDigest).toBe(
      (await serve(row)).projectionDigest,
    );
  });

  test("a deferred AST replacement describes the final wire AST", async () => {
    const resolvedAst = ast("newly fetched text");
    const projected = await transientDecisionAstProjection({
      resolvedAst,
      plainText: "omit",
    });
    if (projected.documentAst === null) {
      throw new Error("Deferred AST was empty after normalization");
    }
    const reparsed = parseDocumentAst(JSON.stringify(projected.documentAst));
    if (reparsed === null) {
      throw new Error("Deferred AST failed to parse from the response");
    }

    expect(projected.documentAst.blocks.at(0)).not.toHaveProperty("plainText");
    expect(projected.projectionDigest).toBe(
      await projectionDigest(resolvedAst),
    );
    expect(projected.projectionDigest).toBe(await projectionDigest(reparsed));
    expect(projected.documentAstSource).toBeNull();
  });
});
