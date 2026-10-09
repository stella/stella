import { describe, expect, test } from "bun:test";
import { status } from "elysia";
import * as v from "valibot";

import { blockSchema } from "@stll/legal-ast/document-ast";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  brandPersistedCaseLawDecisionId,
  brandPersistedLegislationDocumentId,
} from "@/api/lib/safe-id-boundaries";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { McpRequestContext } from "./context";
import {
  blocksDecisionOutput,
  openDecisionOutput,
  provisionPreviewOutput,
  READER_PAGE_MAX_CHARS,
} from "./decision-reader-contract";
import { DECISION_READER_TOOL_SET } from "./decision-reader-tools";
import { decodeReaderCursor } from "./decision-reader.logic";
import type { ReaderSource } from "./decision-reader.logic";
import type { McpToolHandler, McpToolResponse } from "./tool-types";

const id = "af6c7d89-41ab-42ba-814e-b657703584eb";
const otherId = "af6c7d89-41ab-42ba-814e-b657703584ec";
const documentId = brandPersistedLegislationDocumentId(
  "cc6c7d89-41ab-42ba-814e-b657703584eb",
);
const astOf = (count = 8): DocumentAst => ({
  version: 1,
  source: {
    system: "test",
    documentId: id,
    webUrl: "https://example.test/decision",
    printUrl: "",
  },
  metadata: {
    caseNumber: "1 Test 2026",
    ecli: null,
    court: "Test court",
    decisionDate: "2026-01-01",
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: Array.from({ length: count }, (_, index) => ({
    type: "paragraph",
    id: `block-${index}`,
    anchorId: `court-${index}`,
    number: index + 48,
    inlines: [
      { type: "text", text: `Paragraph ${index + 48} ${"text ".repeat(600)}` },
    ],
    plainText: `Paragraph ${index + 48} ${"text ".repeat(600)}`,
  })),
});
const sourceOf = (
  ast = astOf(),
  textAccess: "readable" | "withheld" = "readable",
) =>
  ({
    status: "read",
    decision: {
      id: brandPersistedCaseLawDecisionId(id),
      caseNumber: "1 Test 2026",
      court: "Test court",
      country: "CZE",
      decisionDate: "2026-01-01",
      ecli: null,
      language: "cs",
      languageAlternates: [],
      slug: null,
    },
    textAccess,
    ast: textAccess === "readable" ? ast : null,
    citationAnchors: [
      {
        pieceId: "block-0",
        start: 0,
        end: 8,
        citationId: "citation",
        decisionId: otherId,
      },
    ],
    provisionAnchors: [
      {
        pieceId: "block-0",
        start: 10,
        end: 16,
        provision: {
          document_id: documentId,
          anchor: "par_1",
          cited_anchor: "par_1-odst_1",
        },
      },
    ],
    referenceNextCursor: null,
  }) satisfies ReaderSource;
const contextWith = (
  testDependencies: NonNullable<McpRequestContext["testDependencies"]>,
) => asTestRaw<McpRequestContext>({ testDependencies });

type HandlerInput = Parameters<McpToolHandler>[0];

// Registry handlers erase their data type; parsing through the published
// output schema restores it and asserts the contract on every call.
const typedCall =
  <TSchema extends v.GenericSchema>(
    handler: (
      input: HandlerInput,
    ) => McpToolResponse | Promise<McpToolResponse>,
    output: TSchema,
  ) =>
  async (input: HandlerInput) => {
    const response = await handler(input);
    if ("egress" in response) {
      throw new Error("Decision reader tools return data, not egress plans");
    }
    return response.status === "success"
      ? { status: "success" as const, data: v.parse(output, response.data) }
      : response;
  };

const open = typedCall(
  DECISION_READER_TOOL_SET.handlers.open_case_law_decision,
  openDecisionOutput,
);
const blocks = typedCall(
  DECISION_READER_TOOL_SET.handlers.read_case_law_decision_blocks,
  blocksDecisionOutput,
);
const preview = typedCall(
  DECISION_READER_TOOL_SET.handlers.preview_cited_provision,
  provisionPreviewOutput,
);

describe("decision reader tool contracts", () => {
  test("anchor page offsets reset across reference cursors and phase transitions", async () => {
    const source = sourceOf(astOf(1));
    const citationPages = [80, 7].map((count, page) =>
      Array.from({ length: count }, (_, index) => ({
        pieceId: `piece-${"x".repeat(800)}`,
        start: 0,
        end: 8,
        citationId: `citation-${page}-${index}`,
        decisionId: otherId,
      })),
    );
    const provisionPages = [3, 2].map((count, page) =>
      Array.from({ length: count }, (_, index) => ({
        pieceId: `provision-${page}-${index}`,
        start: 0,
        end: 8,
        provision: {
          document_id: documentId,
          anchor: `par_${page}_${index}`,
          cited_anchor: `par_${page}_${index}`,
        },
      })),
    );
    const reads = new Set<string>();
    const context = contextWith({
      readDecisionReaderSource: async ({ phase, referenceCursor }) => {
        reads.add(`${phase}:${referenceCursor ?? "first"}`);
        const page = referenceCursor === undefined ? 0 : 1;
        return {
          ...source,
          citationAnchors:
            phase === "citations" ? (citationPages.at(page) ?? []) : [],
          provisionAnchors:
            phase === "provisions" ? (provisionPages.at(page) ?? []) : [],
          referenceNextCursor:
            phase === "blocks" || page === 1 ? null : `${phase}-next`,
        };
      },
    });
    const citations: string[] = [];
    const provisions: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let completed = false;
    for (let page = 0; page < 30; page += 1) {
      const result = await blocks({
        args: { decision_id: id, ...(cursor === undefined ? {} : { cursor }) },
        context,
      });
      if (
        result.status !== "success" ||
        result.data.content.status !== "available"
      ) {
        throw new Error("Expected a bounded anchor page");
      }
      expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(
        READER_PAGE_MAX_CHARS,
      );
      expect(v.safeParse(blocksDecisionOutput, result.data).success).toBe(true);
      citations.push(
        ...result.data.content.citationAnchors.map(
          (anchor) => anchor.citationId,
        ),
      );
      provisions.push(
        ...result.data.content.provisionAnchors.map(
          (anchor) => anchor.provision.anchor,
        ),
      );
      if (result.data.content.nextCursor === null) {
        completed = true;
        break;
      }
      expect(cursors.has(result.data.content.nextCursor)).toBe(false);
      cursors.add(result.data.content.nextCursor);
      cursor = result.data.content.nextCursor;
    }
    expect(completed).toBe(true);
    expect(citations).toEqual(
      citationPages.flat().map((anchor) => anchor.citationId),
    );
    expect(provisions).toEqual(
      provisionPages.flat().map((anchor) => anchor.provision.anchor),
    );
    expect([...reads]).toEqual([
      "blocks:first",
      "citations:first",
      "citations:citations-next",
      "provisions:first",
      "provisions:provisions-next",
    ]);
  });
  test("opening uses court numbers and a canonical web fragment with a small schema-valid result", async () => {
    const context = contextWith({
      readDecisionReaderSource: async () => sourceOf(),
    });
    const result = await open({
      args: { decision_id: id, paragraphs: "48–49" },
      context,
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected a decision opening result");
    }
    expect(v.safeParse(openDecisionOutput, result.data).success).toBe(true);
    if (result.data.status !== "available") {
      throw new Error("Expected an available decision");
    }
    expect(result.data.window.map((item) => item.anchorId)).toEqual([
      "court-0",
      "court-1",
    ]);
    expect(result.data.metadata.appUrl).toEndWith("#par=48-49");
    expect(JSON.stringify(result.data).length).toBeLessThan(12_000);
    expect(result.data).not.toHaveProperty("items");
  });
  test("all range and identifier rejections are typed before reading", async () => {
    let reads = 0;
    const context = contextWith({
      readDecisionReaderSource: async () => {
        reads += 1;
        return sourceOf();
      },
    });
    for (const args of [
      { decision_id: "invalid" },
      { decision_id: id, paragraphs: "49-48" },
      { decision_id: id, paragraphs: "1-501" },
    ]) {
      const result = await open({ args, context });
      expect(result.status).toBe("error");
      if (result.status === "error" && result.error.type === "structured") {
        expect(result.error.code).toBe("validation_error");
      }
    }
    expect(reads).toBe(0);
    const absent = await open({
      args: { decision_id: id, paragraphs: "1" },
      context,
    });
    expect(absent.status).toBe("error");
    if (absent.status === "error" && absent.error.type === "structured") {
      expect(absent.error.code).toBe("not_found");
    }
  });
  test("whole decision pagination emits blocks and each anchor stream exactly once", async () => {
    const ast = astOf(80);
    const source = sourceOf(ast);
    let calls = 0;
    const phases: string[] = [];
    const context = contextWith({
      readDecisionReaderSource: async ({ phase }) => {
        calls += 1;
        phases.push(phase);
        return source;
      },
    });
    const ids: string[] = [];
    const citationIds: string[] = [];
    const provisionIds: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const result = await blocks({
        args: { decision_id: id, ...(cursor === undefined ? {} : { cursor }) },
        context,
      });
      expect(result.status).toBe("success");
      if (
        result.status !== "success" ||
        result.data.content.status !== "available"
      ) {
        throw new Error("Expected an available block page");
      }
      expect(v.safeParse(blocksDecisionOutput, result.data).success).toBe(true);
      expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(
        READER_PAGE_MAX_CHARS,
      );
      ids.push(...result.data.content.items.map((block) => block.id));
      citationIds.push(
        ...result.data.content.citationAnchors.map(
          (anchor) => anchor.citationId,
        ),
      );
      provisionIds.push(
        ...result.data.content.provisionAnchors.map(
          (anchor) => anchor.provision.document_id,
        ),
      );
      if (result.data.content.nextCursor === null) {
        break;
      }
      expect(cursors.has(result.data.content.nextCursor)).toBe(false);
      cursors.add(result.data.content.nextCursor);
      cursor = result.data.content.nextCursor;
    }
    expect(ids).toEqual(ast.blocks.map((block) => block.id));
    expect(new Set(ids).size).toBe(80);
    expect(citationIds).toEqual(["citation"]);
    expect(provisionIds).toEqual([documentId]);
    expect(phases.at(-2)).toBe("citations");
    expect(phases.at(-1)).toBe("provisions");
    expect(calls).toBeLessThan(30);
  });
  test("oversized AST blocks reassemble losslessly across bounded Unicode fragments", async () => {
    const ast = astOf(3);
    const large = ast.blocks.at(1);
    if (large?.type !== "paragraph") {
      throw new Error("Expected the paragraph fixture");
    }
    large.plainText = '"\\\n😀'.repeat(20_000);
    large.inlines = [{ type: "text", text: large.plainText }];
    const source = sourceOf(ast);
    const context = contextWith({
      readDecisionReaderSource: async () => source,
    });
    const read: DocumentAst["blocks"] = [];
    let fragmentText = "";
    let cursor: string | undefined;
    for (;;) {
      const result = await blocks({
        args: { decision_id: id, ...(cursor === undefined ? {} : { cursor }) },
        context,
      });
      if (
        result.status !== "success" ||
        result.data.content.status !== "available"
      ) {
        throw new Error("Expected the fragment page");
      }
      expect(v.safeParse(blocksDecisionOutput, result.data).success).toBe(true);
      expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(
        READER_PAGE_MAX_CHARS,
      );
      read.push(...result.data.content.items);
      for (const fragment of result.data.content.blockFragments) {
        expect(fragment.blockId).toBe(large.id);
        expect(fragment.offset).toBe(fragmentText.length);
        fragmentText += fragment.json;
        if (fragmentText.length === fragment.totalChars) {
          read.push(v.parse(blockSchema, JSON.parse(fragmentText)));
          fragmentText = "";
        }
      }
      if (result.data.content.nextCursor === null) {
        break;
      }
      cursor = result.data.content.nextCursor;
    }
    expect(fragmentText).toBe("");
    expect(read).toEqual(ast.blocks);
    expect(new Set(read.map((block) => block.id)).size).toBe(3);
  });
  test("cursors reject cross-decision reuse and AST revisions", async () => {
    let source = sourceOf(astOf(20));
    const context = contextWith({
      readDecisionReaderSource: async () => source,
    });
    const first = await blocks({ args: { decision_id: id }, context });
    if (
      first.status !== "success" ||
      first.data.content.status !== "available" ||
      first.data.content.nextCursor === null
    ) {
      throw new Error("Expected a cursor for the multi-page fixture");
    }
    const cross = await blocks({
      args: { decision_id: otherId, cursor: first.data.content.nextCursor },
      context,
    });
    expect(cross.status).toBe("error");
    if (cross.status === "error" && cross.error.type === "structured") {
      expect(cross.error.code).toBe("validation_error");
    }
    source = sourceOf(astOf(21));
    const changed = await blocks({
      args: { decision_id: id, cursor: first.data.content.nextCursor },
      context,
    });
    expect(changed.status).toBe("error");
    if (changed.status === "error" && changed.error.type === "structured") {
      expect(changed.error.code).toBe("conflict");
    }
  });
  test("an anchor batch revision between pages of one batch is a typed conflict", async () => {
    const citationsOf = (target: string) =>
      Array.from({ length: 80 }, (_, index) => ({
        pieceId: `piece-${"x".repeat(800)}`,
        start: 0,
        end: 8,
        citationId: `citation-${index}`,
        decisionId: target,
      }));
    let citationAnchors = citationsOf(otherId);
    const source = sourceOf(astOf(1));
    const context = contextWith({
      readDecisionReaderSource: async ({ phase }) => ({
        ...source,
        citationAnchors: phase === "citations" ? citationAnchors : [],
        provisionAnchors: [],
        referenceNextCursor: null,
      }),
    });
    let cursor: string | undefined;
    let midBatch: string | null = null;
    for (let page = 0; page < 10 && midBatch === null; page += 1) {
      const result = await blocks({
        args: { decision_id: id, ...(cursor === undefined ? {} : { cursor }) },
        context,
      });
      if (
        result.status !== "success" ||
        result.data.content.status !== "available" ||
        result.data.content.nextCursor === null
      ) {
        throw new Error("Expected a continuation inside the citation batch");
      }
      cursor = result.data.content.nextCursor;
      const position = decodeReaderCursor(cursor);
      if (position?.phase === "citations" && position.offset > 0) {
        midBatch = cursor;
      }
    }
    if (midBatch === null) {
      throw new Error("Expected the citation batch to span several pages");
    }
    const unchanged = await blocks({
      args: { decision_id: id, cursor: midBatch },
      context,
    });
    expect(unchanged.status).toBe("success");

    citationAnchors = citationsOf(id);
    const revised = await blocks({
      args: { decision_id: id, cursor: midBatch },
      context,
    });
    expect(revised).toMatchObject({
      status: "error",
      error: { type: "structured", code: "conflict" },
    });
  });
  test("each tool reads for its audience and renders only readable text", async () => {
    const audiences: string[] = [];
    let appText: "readable" | "withheld" = "readable";
    const context = contextWith({
      readDecisionReaderSource: async ({ audience }) => {
        audiences.push(audience);
        return sourceOf(astOf(), audience === "app" ? appText : "withheld");
      },
    });
    const model = await open({
      args: { decision_id: id, paragraphs: "48-49" },
      context,
    });
    if (model.status !== "success" || model.data.status !== "withheld") {
      throw new Error("Expected a withheld opening");
    }
    expect(JSON.stringify(model.data)).not.toContain("Paragraph 48");
    expect(model.data.metadata.appUrl).toEndWith("#par=48-49");

    const shown = await blocks({ args: { decision_id: id }, context });
    if (
      shown.status !== "success" ||
      shown.data.content.status !== "available"
    ) {
      throw new Error("Expected the app reader to show readable text");
    }
    expect(JSON.stringify(shown.data.content.items)).toContain("Paragraph 48");

    appText = "withheld";
    const withheld = await blocks({ args: { decision_id: id }, context });
    if (withheld.status !== "success") {
      throw new Error("Expected withheld metadata");
    }
    expect(withheld.data.content).toEqual({
      status: "withheld",
      withheldReason: expect.objectContaining({ code: "source_licence" }),
    });
    expect(JSON.stringify(withheld.data)).not.toContain("Paragraph 48");
    expect(audiences).toEqual(["model", "app", "app"]);
  });
  test("an opening without decision text still links to the requested range", async () => {
    const result = await open({
      args: { decision_id: id, paragraphs: "48-49" },
      context: contextWith({
        readDecisionReaderSource: async () => ({ ...sourceOf(), ast: null }),
      }),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected opening metadata");
    }
    expect(result.data.status).toBe("unavailable");
    expect(result.data.metadata.appUrl).toEndWith("#par=48-49");
  });
  test("missing or gated decisions are typed not-found and expose no source data", async () => {
    const context = contextWith({ readDecisionReaderSource: async () => null });
    for (const tool of [open, blocks]) {
      const result = await tool({ args: { decision_id: id }, context });
      expect(result.status).toBe("error");
      if (result.status === "error" && result.error.type === "structured") {
        expect(result.error.code).toBe("not_found");
      }
    }
  });
  test("the provision tool reuses the exact consolidated web preview service", async () => {
    let reads = 0;
    const context = contextWith({
      readProvisionPreviewHandler: async ({
        documentId: receivedId,
        anchor,
        citedAnchor,
      }) => {
        reads += 1;
        expect(receivedId).toBe(documentId);
        expect(anchor).toBe("par_1");
        expect(citedAnchor).toBe("par_1-odst_1");
        return {
          documentId,
          language: "cs",
          anchorId: anchor,
          citedAnchorId: citedAnchor ?? null,
          headings: [],
          heading: null,
          blocks: [
            {
              id: "block",
              anchorId: "par_1-odst_1",
              text: "Provision wording",
            },
          ],
        };
      },
    });
    const result = await preview({
      args: {
        provision: {
          document_id: documentId,
          anchor: "par_1",
          cited_anchor: "par_1-odst_1",
        },
      },
      context,
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected a provision preview");
    }
    expect(v.safeParse(provisionPreviewOutput, result.data).success).toBe(true);
    expect(reads).toBe(1);
    const absent = await preview({
      args: { provision: { document_id: documentId, anchor: "par_1" } },
      context: contextWith({
        readProvisionPreviewHandler: async () =>
          status(404, { message: "Provision not found" }),
      }),
    });
    expect(absent.status).toBe("error");
    if (absent.status === "error" && absent.error.type === "structured") {
      expect(absent.error.code).toBe("not_found");
    }
  });
});
