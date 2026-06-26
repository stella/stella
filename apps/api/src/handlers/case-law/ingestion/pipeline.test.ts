import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import type { ScopedDb, Transaction } from "@/api/db";
import { caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { DocumentAst, Inline } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import {
  runIngestionPipeline,
  sanitizeResult,
} from "@/api/handlers/case-law/ingestion/pipeline";
import { createSafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

const concatInlineText = (inlines: Inline[]): string => {
  let out = "";
  for (const node of inlines) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "bold":
      case "italic":
      case "link":
        out += concatInlineText(node.children);
        break;
      case "line-break":
        out += "\n";
        break;
      default:
        break;
    }
  }
  return out;
};

const baseResult = (
  documentAst: IngestionResult["documentAst"],
): IngestionResult => ({
  caseNumber: "X/1/2026",
  court: "Test Court",
  country: "SK",
  language: "sk",
  metadata: {},
  rawHash: "hash",
  documentAst,
});

const astMetadata = {
  caseNumber: "X/1/2026",
  court: "Test Court",
  ecli: "ECLI:SK:TEST:2026:1.1",
  decisionDate: "2026-01-01",
  decisionType: "uznesenie",
  keywords: [],
  statutes: [],
};

const originalCzNsFetchPage = czNsAdapter.fetchPage;

afterEach(() => {
  czNsAdapter.fetchPage = originalCzNsFetchPage;
});

describe("sanitizeResult — documentAst text fields", () => {
  // plainText fields feed the DB full-text search index, so we
  // collapse spaced-letter emphasis ("r o z h o d o l" → "rozhodol")
  // there. Inline text is the court's verbatim rendering, and must
  // not be touched by the sanitizer so the reader shows the document
  // exactly as the court set it.
  test("plainText is collapsed, inline text stays verbatim", () => {
    const ast: DocumentAst = {
      version: 1,
      source: {
        system: "test",
        documentId: "x",
        webUrl: "",
        printUrl: "",
      },
      metadata: astMetadata,
      blocks: [
        {
          id: "b1",
          anchorId: "h-holding",
          type: "heading",
          level: 2,
          role: "section-heading",
          inlines: [
            {
              type: "bold",
              children: [{ type: "text", text: "r o z h o d o l :" }],
            },
          ],
          plainText: "r o z h o d o l :",
        },
        {
          id: "b2",
          anchorId: "p1",
          type: "paragraph",
          inlines: [
            {
              type: "text",
              text: "Podľa § 193 ods.1 z a m i e t a obžalobu.",
            },
          ],
          plainText: "Podľa § 193 ods.1 z a m i e t a obžalobu.",
        },
        {
          id: "b3",
          anchorId: "p2",
          type: "paragraph",
          inlines: [{ type: "text", text: "Normálny text bez medzier." }],
          plainText: "Normálny text bez medzier.",
        },
      ],
    };

    const sanitized = sanitizeResult(baseResult(ast));
    if (!("blocks" in sanitized.documentAst)) {
      throw new Error("sanitized documentAst should be a DocumentAst");
    }

    const [holding, holdingPara, plainPara] = sanitized.documentAst.blocks;
    if (
      holding?.type !== "heading" ||
      holdingPara?.type !== "paragraph" ||
      plainPara?.type !== "paragraph"
    ) {
      throw new Error("unexpected block types after sanitize");
    }

    // plainText is collapsed in-place.
    expect(holding.plainText).toBe("rozhodol:");
    expect(holdingPara.plainText).toBe("Podľa § 193 ods.1 zamieta obžalobu.");
    // Normal text without spaced-letter runs round-trips unchanged.
    expect(plainPara.plainText).toBe("Normálny text bez medzier.");

    // Inline text is NEVER mutated — the reader must render the
    // court's exact formatting.
    expect(concatInlineText(holding.inlines)).toBe("r o z h o d o l :");
    expect(concatInlineText(holdingPara.inlines)).toBe(
      "Podľa § 193 ods.1 z a m i e t a obžalobu.",
    );
    expect(concatInlineText(plainPara.inlines)).toBe(
      "Normálny text bez medzier.",
    );
  });

  test("table cell plainText is collapsed, inline text stays verbatim", () => {
    const ast: DocumentAst = {
      version: 1,
      source: {
        system: "test",
        documentId: "x",
        webUrl: "",
        printUrl: "",
      },
      metadata: astMetadata,
      blocks: [
        {
          id: "b1",
          anchorId: "t1",
          type: "table",
          plainText: "z a m i e t a\nplain cell",
          rows: [
            [
              {
                inlines: [{ type: "text", text: "z a m i e t a" }],
                plainText: "z a m i e t a",
              },
              {
                inlines: [{ type: "text", text: "plain cell" }],
                plainText: "plain cell",
              },
            ],
          ],
        },
      ],
    };

    const sanitized = sanitizeResult(baseResult(ast));
    if (!("blocks" in sanitized.documentAst)) {
      throw new Error("sanitized documentAst should be a DocumentAst");
    }
    const table = sanitized.documentAst.blocks[0];
    if (table?.type !== "table") {
      throw new Error("expected table");
    }
    const [firstRow] = table.rows;
    const [spacedCell, plainCell] = firstRow ?? [];
    if (!spacedCell || !plainCell) {
      throw new Error("expected two cells in first row");
    }

    expect(spacedCell.plainText).toBe("zamieta");
    expect(plainCell.plainText).toBe("plain cell");

    expect(concatInlineText(spacedCell.inlines)).toBe("z a m i e t a");
    expect(concatInlineText(plainCell.inlines)).toBe("plain cell");
  });

  test("keeps short runs of Czech/Slovak single-letter words intact", () => {
    const para = (id: string, text: string) => ({
      id,
      anchorId: id,
      type: "paragraph" as const,
      inlines: [{ type: "text" as const, text }],
      plainText: text,
    });
    const ast: DocumentAst = {
      version: 1,
      source: { system: "test", documentId: "x", webUrl: "", printUrl: "" },
      metadata: astMetadata,
      blocks: [
        // "u a v" are three real prepositions, not letter-spaced emphasis.
        para("p1", "bydlel u a v dome"),
        para("p2", "podiel i s príslušenstvom"),
        // A genuine letter-spaced word (>= 4 letters) must still collapse.
        para("p3", "súd r o z h o d o l takto"),
      ],
    };

    const sanitized = sanitizeResult(baseResult(ast));
    if (!("blocks" in sanitized.documentAst)) {
      throw new Error("sanitized documentAst should be a DocumentAst");
    }
    const [prep1, prep2, spaced] = sanitized.documentAst.blocks;
    if (
      prep1?.type !== "paragraph" ||
      prep2?.type !== "paragraph" ||
      spaced?.type !== "paragraph"
    ) {
      throw new Error("unexpected block types");
    }

    expect(prep1.plainText).toBe("bydlel u a v dome");
    expect(prep2.plainText).toBe("podiel i s príslušenstvom");
    expect(spaced.plainText).toBe("súd rozhodol takto");
  });
});

describe("runIngestionPipeline — database timeouts", () => {
  test("holds the source cursor when a decision DB operation times out", async () => {
    const source = {
      id: createSafeId<"caseLawSource">(),
      adapterKey: ADAPTER_KEYS.CZ_NS,
      name: "Timeout source",
      enabled: true,
      syncCursor: "cursor-1",
      lastSyncAt: null,
      config: {},
      descriptor: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } satisfies typeof caseLawSources.$inferSelect;

    const decision = baseResult({});
    czNsAdapter.fetchPage = async () =>
      Result.ok({ decisions: [decision], nextCursor: "cursor-2" });

    let calls = 0;
    let persistedCursor: string | null | undefined;
    const scopedDb: ScopedDb = async (callback) => {
      calls++;

      if (calls === 1) {
        throw new TimeoutError({
          message: "decision write exceeded deadline",
          label: "ingestion-db-transaction",
          timeoutMs: 10,
        });
      }

      const tx = {
        update: (table: unknown) => ({
          set: (values: { syncCursor?: string | null }) => {
            if (table === caseLawSources) {
              persistedCursor = values.syncCursor;
            }

            return { where: async () => undefined };
          },
        }),
      };

      // SAFETY: this test exercises only the final case_law_sources cursor
      // update after the synthetic timeout; the fake implements that chain.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    const result = await runIngestionPipeline({ source, scopedDb });

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.haltReason?.startsWith("Database timeout;")).toBe(true);
    expect(persistedCursor).toBe("cursor-1");
  });
});
