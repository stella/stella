import { describe, expect, test } from "bun:test";

import { headingPathsByAnchor } from "@stll/legal-ast";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { projectionDigest } from "@stll/legal-ast/projection-digest";

import {
  readServedDecisionAst,
  transientDecisionAstProjection,
} from "@/api/handlers/case-law/decisions/served-ast";
import { createSafeId } from "@/api/lib/branded-types";
import { decisionOutline } from "@/api/mcp/case-law-decision-outline";

const ast = (text: string): DocumentAst => ({
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
      readStore: async () => stored,
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
      readStore: async () => null,
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
      readStore: async () => ast("not read"),
    });

    expect(served).toEqual({
      payload: null,
      source: null,
      projectionDigest: null,
    });
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
        readStore: async () => null,
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
