import { Result } from "better-result";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { WriteCorpusResult } from "@/api/handlers/case-law/corpus-storage";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { createSafeId } from "@/api/lib/branded-types";

/**
 * `canonical` storage mode moves the payload out of Postgres, so the two
 * things a type can't check are the ordering (objects must exist before
 * any row points at them) and the failure shape (no row at all, and a held
 * cursor so the next cycle retries).
 */

const realEnvBase = await import("@/api/env-base");

/** Ordered log of the side effects under test, across S3 and the DB. */
const events: string[] = [];
const insertedRows: Record<string, unknown>[] = [];

const writeCorpusDocumentMock = mock(
  async (input: { documentId: string }): Promise<WriteCorpusResult> => {
    events.push(`corpus-write:${input.documentId}`);
    return await Promise.resolve({
      textKey: "corpus/text.zst",
      sectionsKey: "corpus/sections.json.zst",
      astKey: "corpus/ast.json.zst",
      contentHash: "content-hash",
    });
  },
);

void mock.module("@/api/env-base", () => ({
  ...realEnvBase,
  corpusStorageMode: "canonical",
}));

void mock.module("@/api/handlers/case-law/corpus-storage", () => ({
  writeCorpusDocument: writeCorpusDocumentMock,
}));

const { czNsAdapter } =
  await import("@/api/handlers/case-law/ingestion/adapters/cz-ns");
const { processDecision, runIngestionPipeline } =
  await import("@/api/handlers/case-law/ingestion/pipeline");

const originalCzNsFetchPage = czNsAdapter.fetchPage;

let persistedCursor: string | null | undefined;

afterEach(() => {
  czNsAdapter.fetchPage = originalCzNsFetchPage;
  events.length = 0;
  insertedRows.length = 0;
  persistedCursor = undefined;
  writeCorpusDocumentMock.mockClear();
});

const decision: IngestionResult = {
  caseNumber: "X/1/2026",
  court: "Test Court",
  country: "SVK",
  language: "sk",
  fulltext: "Rozhodnutie o veci samej.",
  metadata: {},
  rawHash: "raw-hash",
  documentAst: {},
};

/**
 * Minimal transaction double covering the insert path: the dedup lookup,
 * the slug-collision scan, the decision insert, and the source-cursor
 * update the pipeline runs at the end of a cycle.
 */
const scopedDb: ScopedDb = async (callback) => {
  const tx = {
    query: {
      caseLawDecisions: { findFirst: async () => await Promise.resolve(null) },
    },
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        events.push("row-insert");
        if (table === caseLawDecisions) {
          insertedRows.push(values);
        }
        return {
          returning: async () => await Promise.resolve([{ id: values["id"] }]),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: { syncCursor?: string | null }) => {
        events.push("row-update");
        if (table === caseLawSources) {
          persistedCursor = values.syncCursor;
        }
        return { where: async () => undefined };
      },
    }),
    delete: () => ({ where: async () => undefined }),
  };

  // SAFETY: the double implements exactly the chains this insert path
  // walks; anything else would throw and fail the test loudly.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return await callback(tx as unknown as Transaction);
};

describe("processDecision — canonical storage mode", () => {
  test("writes the corpus objects before the row, and nulls the text columns", async () => {
    const outcome = await processDecision(
      decision,
      createSafeId<"caseLawSource">(),
      scopedDb,
    );

    expect(outcome).toEqual({
      inserted: true,
      searchVectorFailed: false,
      s3UploadFailed: false,
    });

    // No row may exist before its objects do.
    expect(events[0]?.startsWith("corpus-write:")).toBe(true);
    expect(events[1]).toBe("row-insert");

    const [row] = insertedRows;
    expect(events[0]).toBe(`corpus-write:${String(row?.["id"])}`);
    expect(row).toMatchObject({
      fulltext: null,
      sections: null,
      documentAst: null,
      textS3Key: "corpus/text.zst",
      normalizedS3Key: "corpus/sections.json.zst",
      astS3Key: "corpus/ast.json.zst",
      contentHash: "content-hash",
    });
  });

  test("persists nothing when the corpus write fails", async () => {
    writeCorpusDocumentMock.mockImplementationOnce(async () => {
      events.push("corpus-write-failed");
      return await Promise.reject(new Error("bucket unreachable"));
    });

    const outcome = await processDecision(
      decision,
      createSafeId<"caseLawSource">(),
      scopedDb,
    );

    expect(outcome).toEqual({
      inserted: false,
      searchVectorFailed: false,
      s3UploadFailed: true,
    });
    expect(events).toEqual(["corpus-write-failed"]);
    expect(insertedRows).toHaveLength(0);
  });
});

describe("runIngestionPipeline — canonical corpus write failure", () => {
  test("holds the cursor so the next cycle retries the decision", async () => {
    writeCorpusDocumentMock.mockImplementationOnce(
      async () => await Promise.reject(new Error("bucket unreachable")),
    );

    const source = {
      id: createSafeId<"caseLawSource">(),
      adapterKey: ADAPTER_KEYS.CZ_NS,
      name: "Canonical source",
      enabled: true,
      syncCursor: "cursor-1",
      lastSyncAt: null,
      config: {},
      descriptor: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } satisfies typeof caseLawSources.$inferSelect;

    czNsAdapter.fetchPage = async () =>
      await Promise.resolve(
        Result.ok({ decisions: [decision], nextCursor: "cursor-2" }),
      );

    const result = await runIngestionPipeline({ source, scopedDb });

    expect(result.inserted).toBe(0);
    expect(result.s3UploadFailures).toBe(1);
    expect(result.pagesProcessed).toBe(0);
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.haltReason).toContain("corpus write failure(s)");
    expect(persistedCursor).toBe("cursor-1");
    expect(insertedRows).toHaveLength(0);
  });
});
