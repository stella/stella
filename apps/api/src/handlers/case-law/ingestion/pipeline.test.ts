import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import type { DocumentAst, Inline } from "@/api/handlers/case-law/document-ast";
import {
  EMPTY_AST,
  SOURCE_DOCUMENT_ID_MAX_LENGTH,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { decisionIdentifiersFromStoredMetadata } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  wrappedErrorDetail,
  processDecision,
  runIngestionPipeline,
  sanitizeResult,
} from "@/api/handlers/case-law/ingestion/pipeline";
import { createSafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { partialObservationFromMetadata } from "@/api/lib/legal-search/ingestion-normalization";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";

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
      case "page-anchor":
        // Zero characters on the text axis.
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

const testSourceLease = (
  source: typeof caseLawSources.$inferSelect,
): CaseLawSourceIngestionLease => ({
  beforeDatabaseMark: async () => undefined,
  beforeRemoteEffect: async (effect) => await effect(),
  leaseToken: createSafeId<"caseLawSourceIngestionLease">(),
  release: async () => undefined,
  source,
});

afterEach(() => {
  czNsAdapter.fetchPage = originalCzNsFetchPage;
});

describe("sanitizeResult — adapter-supplied sections", () => {
  test("strips control characters the way every other field is stripped", () => {
    // Sections arrive from court HTML like `fulltext` and `documentAst`
    // do. The wording-based fallback was safe only because
    // `segmentDecision` runs on already-sanitized `fulltext`; a parser
    // that supplies its own sections bypasses that.
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      sections: [
        {
          index: 0,
          type: "ruling",
          title: "Vy\u0000rok",
          text: "Text\u0000with\u200Bcontrol\uFEFFchars.",
        },
      ],
    });

    expect(sanitized.sections?.at(0)?.title).toBe("Vyrok");
    expect(sanitized.sections?.at(0)?.text).toBe("Textwithcontrolchars.");
  });

  test("leaves a section without a title as null", () => {
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      sections: [{ index: 0, type: "ruling", title: null, text: "Text." }],
    });

    expect(sanitized.sections?.at(0)?.title).toBeNull();
  });
});

describe("sanitizeResult — decision identifiers", () => {
  test("persists the complete source identifier set for exact replay", () => {
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
          value: "12 Test Reporter 34",
        },
      ],
    });

    expect(
      decisionIdentifiersFromStoredMetadata({
        caseNumber: sanitized.caseNumber,
        ecli: sanitized.ecli ?? null,
        metadata: sanitized.metadata,
      }),
    ).toEqual([
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "X/1/2026",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "12 Test Reporter 34",
      },
    ]);
  });
});

describe("sanitizeResult — decision date bounds", () => {
  // Adapters normalize dates differently or not at all, and the column
  // takes an impossible year as readily as a real one. A document whose
  // date is unusable is still worth storing, so the date drops and the
  // row survives.
  test("drops a year outside the range a decision can carry", () => {
    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "2944-04-30",
      }).decisionDate,
    ).toBeUndefined();

    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "0001-01-01",
      }).decisionDate,
    ).toBeUndefined();
  });

  test("drops a day that does not exist on the calendar", () => {
    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "2026-02-30",
      }).decisionDate,
    ).toBeUndefined();
  });

  test("keeps a date the sources actually publish", () => {
    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "2026-04-15",
      }).decisionDate,
    ).toBe("2026-04-15");

    expect(
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        decisionDate: "2026-04-15T00:00:00Z",
      }).decisionDate,
    ).toBe("2026-04-15");
  });

  test("leaves an absent date absent", () => {
    expect(sanitizeResult(baseResult(EMPTY_AST)).decisionDate).toBeUndefined();
  });
});

describe("sanitizeResult — shared partial-observation quality", () => {
  test("persists adapter-neutral quality and removes it after detail recovery", () => {
    const partial = sanitizeResult({
      ...baseResult(EMPTY_AST),
      caseNumberIsPlaceholder: true,
      isListingOnly: true,
    });
    expect(partialObservationFromMetadata(partial.metadata)).toEqual({
      caseNumberIsPlaceholder: true,
      isListingOnly: true,
    });

    const recovered = sanitizeResult({
      ...partial,
      caseNumberIsPlaceholder: undefined,
      isListingOnly: undefined,
    });
    expect(partialObservationFromMetadata(recovered.metadata)).toEqual({
      caseNumberIsPlaceholder: false,
      isListingOnly: false,
    });
  });
});

describe("sanitizeResult — shared publisher identity limits", () => {
  test("drops an oversized alias without poisoning a valid canonical id", () => {
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      sourceDocumentId: "publisher:canonical",
      sourceDocumentIdAliases: [
        "publisher:fallback",
        "x".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      ],
      sourceDocumentIdRepairAliases: [
        "publisher:repair",
        "x".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      ],
    });

    expect(sanitized.sourceDocumentIdAliases).toEqual(["publisher:fallback"]);
    expect(sanitized.sourceDocumentIdRepairAliases).toEqual([
      "publisher:repair",
    ]);
  });

  test("rejects an oversized canonical id instead of truncating identity", () => {
    expect(() =>
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        sourceDocumentId: "x".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      }),
    ).toThrow("Publisher document identity exceeds storage limits");
  });

  test("drops aliases changed by sanitization instead of merging identities", () => {
    const sanitized = sanitizeResult({
      ...baseResult(EMPTY_AST),
      sourceDocumentId: "publisher:canonical",
      sourceDocumentIdAliases: ["publisher:a\u200Bb", "publisher:ab"],
      sourceDocumentIdRepairAliases: [
        "publisher:repair\u200Bchanged",
        "publisher:repair-clean",
      ],
    });

    expect(sanitized.sourceDocumentIdAliases).toEqual(["publisher:ab"]);
    expect(sanitized.sourceDocumentIdRepairAliases).toEqual([
      "publisher:repair-clean",
    ]);
  });

  test("rejects a canonical id changed by sanitization", () => {
    expect(() =>
      sanitizeResult({
        ...baseResult(EMPTY_AST),
        sourceDocumentId: "publisher:a\u200Bb",
      }),
    ).toThrow("Publisher document identity cannot be sanitized");
  });
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
    const source = caseLawSourceRow({ name: "Timeout source" });

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
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({ limit: async () => await Promise.resolve([]) }),
              limit: async () => await Promise.resolve([]),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        update: (table: unknown) => ({
          set: (values: { syncCursor?: string | null }) => {
            if (table === caseLawSources) {
              persistedCursor = values.syncCursor;
            }

            return {
              where: () => ({
                returning: async () => [
                  { cursor: values.syncCursor ?? null, order: 1n },
                ],
              }),
            };
          },
        }),
      };

      // SAFETY: this test exercises only the final case_law_sources cursor
      // update after the synthetic timeout; the fake implements that chain.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    const result = await runIngestionPipeline({
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
    });

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.haltReason?.startsWith("Database timeout;")).toBe(true);
    expect(persistedCursor).toBe("cursor-1");
  });
});

describe("runIngestionPipeline — empty-page cursor progress", () => {
  test("persists the fetched cursor when the cycle aborts on an empty page", async () => {
    const source = caseLawSourceRow({ name: "Empty-page source" });

    // The cycle deadline fires while the fetch is in flight; the page it
    // returns carries no decisions but real cursor progress. Acquiring the
    // DB slot here used to throw AbortError before the cursor advance ran,
    // pinning the adapter to the same cursor on every later cycle.
    const controller = new AbortController();
    czNsAdapter.fetchPage = async () => {
      controller.abort();
      return Result.ok({ decisions: [], nextCursor: "cursor-2" });
    };

    let acquires = 0;
    const dbSlot = {
      acquire: async (signal?: AbortSignal) => {
        acquires++;
        if (signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
      },
      release: () => undefined,
    };

    let persistedCursor: string | null | undefined;
    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({ limit: async () => await Promise.resolve([]) }),
              limit: async () => await Promise.resolve([]),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        update: (table: unknown) => ({
          set: (values: { syncCursor?: string | null }) => {
            if (table === caseLawSources) {
              persistedCursor = values.syncCursor;
            }

            return {
              where: () => ({
                returning: async () => [
                  { cursor: values.syncCursor ?? null, order: 1n },
                ],
              }),
            };
          },
        }),
      };

      // SAFETY: this test exercises only the final case_law_sources cursor
      // update (the empty page performs no decision writes); the fake
      // implements that chain.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    const result = await runIngestionPipeline({
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
      signal: controller.signal,
      maxPages: 1,
      dbSlot,
    });

    // An empty page has no DB work, so the slot must never be contended.
    expect(acquires).toBe(0);
    expect(result.pagesProcessed).toBe(1);
    expect(result.nextCursor).toBe("cursor-2");
    expect(persistedCursor).toBe("cursor-2");
  });
});

describe("wrappedErrorDetail", () => {
  test("keeps the cause when the outer message is long", () => {
    const cause = new Error("connection reset by peer");
    const outer = new Error(`Failed query: ${"select ".repeat(200)}`, {
      cause,
    });
    const detail = wrappedErrorDetail(outer);
    expect(detail).toContain("connection reset by peer");
    expect(detail.length).toBeLessThanOrEqual(200 + 300 + 16);
  });

  test("bounds the cause independently of the outer message", () => {
    const cause = new Error("x".repeat(1000));
    const detail = wrappedErrorDetail(new Error("short", { cause }));
    expect(detail.startsWith("short (cause: ")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(200 + 300 + 16);
  });

  test("stringifies non-Error values", () => {
    expect(wrappedErrorDetail("boom")).toBe("boom");
  });
});

describe("processDecision — corpus storage off", () => {
  test("clears corpus pointers left behind by an earlier mode", async () => {
    // Rolling back to `off` makes the Postgres columns canonical again, and
    // no corpus write follows this refresh to rewrite the keys. Left alone,
    // the row would keep pointing at objects that no longer match its text.
    const existing = {
      id: createSafeId<"caseLawDecision">(),
      metadata: {},
      sourceHash: "old-hash",
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };
    const sourceId = createSafeId<"caseLawSource">();

    let updated: Record<string, unknown> | undefined;
    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              for: () => ({
                limit: async () =>
                  await Promise.resolve(
                    table === caseLawSources ? [{ id: sourceId }] : [],
                  ),
              }),
              limit: async () => await Promise.resolve([]),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        query: {
          caseLawDecisions: {
            findFirst: async () => await Promise.resolve(existing),
          },
        },
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => {
            if (table === caseLawDecisions) {
              updated = values;
            }
            return {
              where: () => ({
                returning: async () => [{ id: existing.id }],
              }),
            };
          },
        }),
        delete: () => ({ where: async () => undefined }),
        insert: () => ({ values: async () => undefined }),
      };

      // SAFETY: the refresh path walks only these chains; anything else
      // would throw and fail the test loudly.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    const outcome = await processDecision({
      input: {
        caseNumber: "X/1/2026",
        court: "Test Court",
        country: "SVK",
        language: "sk",
        fulltext: "Rozhodnutie o veci samej.",
        metadata: {},
        rawHash: "new-hash",
        documentAst: EMPTY_AST,
      },
      observationOrder: 1n,
      sourceId,
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    expect(outcome.inserted).toBe(true);
    expect(updated).toMatchObject({
      fulltext: "Rozhodnutie o veci samej.",
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
      contentHash: null,
    });
  });
});

describe("processDecision — decision date on an existing row", () => {
  // An update omits an undefined column, so a rejected date has to be
  // distinguishable from an unstated one all the way to the write: the
  // first must clear whatever the row holds, the second must not.
  const refreshedDecisionDate = async (
    decisionDate: string | undefined,
  ): Promise<Record<string, unknown> | undefined> => {
    const existing = {
      id: createSafeId<"caseLawDecision">(),
      metadata: {},
      sourceHash: "old-hash",
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };
    const sourceId = createSafeId<"caseLawSource">();

    let updated: Record<string, unknown> | undefined;
    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              for: () => ({
                limit: async () =>
                  await Promise.resolve(
                    table === caseLawSources ? [{ id: sourceId }] : [],
                  ),
              }),
              limit: async () => await Promise.resolve([]),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        query: {
          caseLawDecisions: {
            findFirst: async () => await Promise.resolve(existing),
          },
        },
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => {
            if (table === caseLawDecisions) {
              updated = values;
            }
            return {
              where: () => ({
                returning: async () => [{ id: existing.id }],
              }),
            };
          },
        }),
        delete: () => ({ where: async () => undefined }),
        insert: () => ({ values: async () => undefined }),
      };

      // SAFETY: the refresh path walks only these chains; anything else
      // would throw and fail the test loudly.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    await processDecision({
      input: {
        caseNumber: "X/1/2026",
        court: "Test Court",
        country: "SVK",
        language: "sk",
        decisionDate,
        fulltext: "Rozhodnutie o veci samej.",
        metadata: {},
        rawHash: "new-hash",
        documentAst: EMPTY_AST,
      },
      observationOrder: 1n,
      sourceId,
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    return updated;
  };

  test("clears the column when the source restates an unusable date", async () => {
    const updated = await refreshedDecisionDate("2944-04-30");

    expect(updated?.["decisionDate"]).toBeNull();
  });

  test("writes a usable date", async () => {
    const updated = await refreshedDecisionDate("2026-04-15");

    expect(updated?.["decisionDate"]).toBe("2026-04-15");
  });

  test("writes nothing when the source states no date", async () => {
    const updated = await refreshedDecisionDate(undefined);

    expect(updated?.["decisionDate"]).toBeUndefined();
  });
});

describe("processDecision — source raw upload failure", () => {
  let fake: FakeS3;
  let logs: RecordingLogger;

  beforeEach(() => {
    fake = startFakeS3();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    logs.restore();
    fake.stop();
  });

  /** The key the raw payload is content-addressed under. */
  const rawKey = (sourceId: string, payload: string): string =>
    `case-law/raw/${sourceId}/${new Bun.CryptoHasher("sha256").update(payload).digest("hex")}`;

  test("reports a new decision's failed raw upload as retryable, not thrown", async () => {
    // A thrown failure is caught by the decision loop, counted as skipped,
    // and lets the page's cursor advance; a forward-only traversal then
    // never returns to the decision and its raw source is lost. Only a
    // retryable outcome reaches the page-level cursor hold.
    //
    // The store rejects the write the way it rejects a denied one in
    // production: `AccessDenied` is terminal, so the retry inside
    // `writeS3ObjectWithRetry` does not turn this into three attempts.
    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });
    const sourceId = createSafeId<"caseLawSource">();
    const sourceRaw = "<html></html>";

    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({ limit: async () => await Promise.resolve([]) }),
              limit: async () => await Promise.resolve([]),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        query: {
          caseLawDecisions: {
            findFirst: async () => await Promise.resolve(undefined),
          },
        },
      };

      // SAFETY: the raw upload runs before any decision write, so the
      // dedup lookup is the only chain this path reaches.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    const outcome = await processDecision({
      input: {
        caseNumber: "X/2/2026",
        court: "Test Court",
        country: "SVK",
        language: "sk",
        fulltext: "Rozhodnutie o veci samej.",
        metadata: {},
        rawHash: "new-hash",
        documentAst: EMPTY_AST,
        sourceRaw,
      },
      observationOrder: 1n,
      sourceId,
      scopedDb,
      observedAt: new Date("2026-08-03T00:00:00.000Z"),
    });

    if (outcome.status !== "retryable") {
      throw new Error(`expected a retryable outcome, got ${outcome.status}`);
    }

    expect(outcome.inserted).toBe(false);
    // The reason selects the halt message and keeps this failure
    // attributable apart from a corpus-write failure, so pin it: asserting
    // only the status would pass on the corpus-write reason too.
    expect(outcome.reason).toBe("source-raw-write");
    // The rejected write was the payload's own content-addressed key in the
    // case-law partition, and nothing landed: the held cursor is the only
    // record of this decision, so the retry has the whole upload to redo.
    const writes = fake.requests.filter(({ method }) => method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes.at(0)?.bucket).toBe(envBase.S3_BUCKET);
    expect(writes.at(0)?.key).toBe(rawKey(sourceId, sourceRaw));
    // The charset parameter is the client's; the media type is the
    // pipeline's, and it is what a re-parse reads the object back as.
    expect(writes.at(0)?.contentType).toMatch(/^text\/plain\b/u);
    expect(fake.objects.size).toBe(0);
  });

  test("logs the failure's system fields, not just its message", async () => {
    // Bun's S3 client collapses every write failure to the same
    // message, so `error.detail` alone cannot tell an access denial
    // from a timeout. `errorSystemFields` carries the discriminating
    // `code`/`errno`/`syscall`, which is what makes a held cursor
    // diagnosable from the log. The code comes from the store's own
    // rejection through the real client, so this also pins that the
    // client still surfaces it where `errorSystemFields` looks.
    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });

    const scopedDb: ScopedDb = async (callback) => {
      const tx = {
        // The identity the refresh replaces is read FOR UPDATE before the
        // write. This suite asserts the decision row, so it reports no prior
        // identity and the citation-graph branch stays out of the way.
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({ limit: async () => await Promise.resolve([]) }),
              limit: async () => await Promise.resolve([]),
            }),
          }),
        }),
        // The citation-graph settle the pipeline runs in the same
        // transaction is raw SQL; this suite asserts the decision row, so
        // the statement is accepted and reports nothing settled.
        execute: async () => await Promise.resolve([]),
        query: {
          caseLawDecisions: {
            findFirst: async () => await Promise.resolve(undefined),
          },
        },
      };

      // SAFETY: the raw upload runs before any decision write, so the
      // dedup lookup is the only chain this path reaches.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return await callback(tx as unknown as Transaction);
    };

    await processDecision({
      input: {
        caseNumber: "X/3/2026",
        court: "Test Court",
        country: "SVK",
        language: "sk",
        fulltext: "Rozhodnutie o veci samej.",
        metadata: {},
        rawHash: "new-hash",
        documentAst: EMPTY_AST,
        sourceRaw: "<html></html>",
      },
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-08-05T00:00:00.000Z"),
    });

    const failure = logs.at("ERROR").at(0);
    expect(failure?.attributes?.["error.code"]).toBe("AccessDenied");
  });
});
