import { Result } from "better-result";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCorpusUploadIntents,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { createSafeId } from "@/api/lib/branded-types";
import { DatabaseError, TimeoutError } from "@/api/lib/errors/tagged-errors";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { WriteCorpusResult } from "@/api/lib/legal-search/corpus-storage";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

/**
 * `canonical` storage mode moves the payload out of Postgres, so what a
 * type cannot check is the ordering: the row and durable upload intent must
 * exist before external I/O, and the row may only point at objects after the
 * fenced write succeeds.
 */

const realEnvBase = await import("@/api/env-base");
const realCorpusStorage = await import("@/api/lib/legal-search/corpus-storage");

/** Ordered log of the side effects under test, across S3 and the DB. */
const events: string[] = [];
const insertedRows: Record<string, unknown>[] = [];
const updatedDecisionRows: Record<string, unknown>[] = [];

const CORPUS_KEYS = {
  textKey: "corpus/text.zst",
  sectionsKey: "corpus/sections.json.zst",
  astKey: "corpus/ast.json.zst",
} as const;

const writeCorpusDocumentMock = mock(
  async (input: { documentId: string }): Promise<WriteCorpusResult> => {
    events.push(`corpus-write:${input.documentId}`);
    return await Promise.resolve({
      ...CORPUS_KEYS,
      contentHash: "content-hash",
    });
  },
);

type CorpusDocumentKeys = {
  textKey: string | null;
  sectionsKey: string | null;
  astKey: string | null;
};

const deletedKeys: CorpusDocumentKeys[] = [];

const deleteCorpusDocumentMock = mock(
  async (keys: CorpusDocumentKeys): Promise<void> => {
    events.push("corpus-delete");
    deletedKeys.push(keys);
    await Promise.resolve();
  },
);

void mock.module("@/api/env-base", () => ({
  ...realEnvBase,
  corpusStorageMode: "canonical",
}));

// Only the two I/O entry points are faked; the key derivation stays real so
// the partial-write cleanup is exercised against the actual key layout.
void mock.module("@/api/lib/legal-search/corpus-storage", () => ({
  ...realCorpusStorage,
  writeCorpusDocument: writeCorpusDocumentMock,
  deleteCorpusDocument: deleteCorpusDocumentMock,
}));

const { czNsAdapter } =
  await import("@/api/handlers/case-law/ingestion/adapters/cz-ns");
const { processDecision, runIngestionPipeline } =
  await import("@/api/handlers/case-law/ingestion/pipeline");

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

let persistedCursor: string | null | undefined;
/**
 * How the decision insert behaves. `fault` is an unambiguous failure;
 * `timeout` is the transaction bound firing, which abandons rather than
 * cancels the statement and so proves nothing about whether it committed.
 */
let rowWrite: "ok" | "fault" | "timeout" = "ok";
/** The row the dedup lookup finds; undefined makes this a new decision. */
let existingDecision: Record<string, unknown> | undefined;
/** Whether the observation still owns the mirror when it settles. */
let mirrorSettlementApplied = true;
let intentStatus: "active" | "cleanup" = "active";

afterEach(() => {
  czNsAdapter.fetchPage = originalCzNsFetchPage;
  events.length = 0;
  insertedRows.length = 0;
  updatedDecisionRows.length = 0;
  deletedKeys.length = 0;
  persistedCursor = undefined;
  rowWrite = "ok";
  existingDecision = undefined;
  mirrorSettlementApplied = true;
  intentStatus = "active";
  writeCorpusDocumentMock.mockClear();
  deleteCorpusDocumentMock.mockClear();
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
      // drizzle's relational API returns undefined for a miss.
      caseLawDecisions: {
        findFirst: async () => await Promise.resolve(existingDecision),
      },
    },
    select: (selection: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = async () => {
            if (table === caseLawCorpusUploadIntents) {
              return [{ status: intentStatus }];
            }
            if ("redactedAt" in selection) {
              return [{ redactedAt: null }];
            }
            if ("id" in selection) {
              return [{ id: "decision-id" }];
            }
            return [];
          };
          return {
            limit: rows,
            for: () => ({ limit: rows }),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const outcome = table === caseLawDecisions ? rowWrite : "ok";
        if (outcome === "ok") {
          if (table === caseLawDecisions) {
            events.push("row-insert");
            insertedRows.push(values);
          } else if (table === caseLawCorpusUploadIntents) {
            events.push("intent-reserve");
          }
        }
        const returning = async () => {
          if (outcome === "timeout") {
            return await Promise.reject(
              new TimeoutError({
                message: "decision write exceeded deadline",
                label: "ingestion-db-transaction",
                timeoutMs: 10,
              }),
            );
          }
          if (outcome === "fault") {
            return await Promise.reject(
              new DatabaseError({ message: "decision insert rejected" }),
            );
          }
          return await Promise.resolve([{ id: values["id"] }]);
        };
        return {
          onConflictDoNothing: () => ({ returning }),
          returning: async () => await returning(),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: { syncCursor?: string | null }) => {
        events.push("row-update");
        if (table === caseLawSources) {
          persistedCursor = values.syncCursor;
        } else if (table === caseLawDecisions) {
          updatedDecisionRows.push(values);
        }
        // The checkpoint helper reads back the compare-and-set winner.
        return {
          where: () => ({
            returning: async () => {
              if (table === caseLawDecisions) {
                return mirrorSettlementApplied ? [{ id: "decision-id" }] : [];
              }
              return [{ cursor: values.syncCursor ?? null, order: 1n }];
            },
          }),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        if (table === caseLawCorpusUploadIntents) {
          events.push("intent-delete");
        }
        return {
          returning: async () =>
            table === caseLawCorpusUploadIntents ? [{ id: "intent-id" }] : [],
        };
      },
    }),
  };

  // SAFETY: the double implements exactly the chains this insert path
  // walks; anything else would throw and fail the test loudly.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return await callback(tx as unknown as Transaction);
};

describe("processDecision — canonical storage mode", () => {
  test("reserves before upload and publishes pointers only after it succeeds", async () => {
    const outcome = await processDecision({
      input: decision,
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    expect(outcome).toEqual({
      status: "complete",
      inserted: true,
      searchVectorFailed: false,
    });

    expect(events.slice(0, 3)).toEqual([
      "row-insert",
      "intent-reserve",
      expect.stringContaining("corpus-write:"),
    ]);

    const [row] = insertedRows;
    expect(events[2]).toBe(`corpus-write:${String(row?.["id"])}`);
    expect(row).toMatchObject({
      fulltext: decision.fulltext,
      corpusMirrorStatus: "pending",
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
      contentHash: null,
    });
    expect(updatedDecisionRows.at(-1)).toMatchObject({
      fulltext: null,
      sections: null,
      documentAst: null,
      textS3Key: "corpus/text.zst",
      normalizedS3Key: "corpus/sections.json.zst",
      astS3Key: "corpus/ast.json.zst",
      contentHash: "content-hash",
      corpusMirrorStatus: "settled",
    });
    expect(events.at(-1)).toBe("intent-delete");
  });

  test("keeps a readable pending row when the corpus write fails", async () => {
    writeCorpusDocumentMock.mockImplementationOnce(async () => {
      events.push("corpus-write-failed");
      return await Promise.reject(new Error("bucket unreachable"));
    });

    const outcome = await processDecision({
      input: decision,
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    expect(outcome).toEqual({
      status: "retryable",
      inserted: true,
      reason: "corpus-write",
    });
    expect(events).toContain("corpus-write-failed");
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows.at(0)).toMatchObject({
      fulltext: decision.fulltext,
      corpusMirrorStatus: "pending",
      contentHash: null,
    });
  });

  test("repairs a pending mirror from a listing-only replay without degrading detail", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    existingDecision = {
      id: decisionId,
      ecli: "ECLI:CZ:TEST:2026:1",
      metadata: { recoveredDetail: true },
      sourceHash: "recovered-detail-hash",
      sourceObservedAt: new Date("2026-07-31T11:00:00.000Z"),
      sourceObservationHash: "first-listing-hash",
      sourceObservationOrder: 1n,
      corpusMirrorStatus: "pending",
      redactedAt: null,
      sourceRawS3Key: "raw/recovered-detail.html",
      sourceRawContentType: "text/html",
      sourceUrl: "https://publisher.example/detail/1",
      fulltext: "Recovered decision text.",
      sections: null,
      documentAst: {},
    };

    const outcome = await processDecision({
      input: {
        ...decision,
        fulltext: undefined,
        isListingOnly: true,
        metadata: { listedOnly: true },
        rawHash: "listing-only-replay-hash",
        sourceRaw: "<tr>listing only</tr>",
        sourceRawContentType: "text/html",
      },
      observationOrder: 2n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    expect(outcome).toEqual({
      status: "complete",
      inserted: true,
      searchVectorFailed: false,
    });
    expect(writeCorpusDocumentMock).toHaveBeenCalledTimes(1);
    expect(updatedDecisionRows[0]).toMatchObject({
      fulltext: "Recovered decision text.",
      sourceHash: "recovered-detail-hash",
      sourceObservationHash: "listing-only-replay-hash",
      sourceObservationOrder: 2n,
    });
    expect(updatedDecisionRows[0]).not.toHaveProperty("caseNumber");
    expect(updatedDecisionRows[0]).not.toHaveProperty("metadata");
    expect(updatedDecisionRows[0]).not.toHaveProperty("sourceRawS3Key");
    expect(updatedDecisionRows.at(-1)).toMatchObject({
      corpusMirrorStatus: "settled",
      fulltext: null,
    });
  });

  test("keeps the objects when the failed write was a refresh", async () => {
    // A refresh derives the same content-addressed keys from the existing
    // id, so when only metadata or the raw source moved they are the
    // objects the live row already points at — and its payload columns are
    // NULL. Deleting them would empty a served decision.
    existingDecision = {
      id: createSafeId<"caseLawDecision">(),
      metadata: {},
      sourceHash: "older-hash",
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };
    writeCorpusDocumentMock.mockImplementationOnce(async () => {
      events.push("corpus-write-failed");
      return await Promise.reject(new Error("bucket unreachable"));
    });

    const outcome = await processDecision({
      input: decision,
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    expect(outcome).toMatchObject({
      status: "retryable",
      reason: "corpus-write",
    });
    expect(events).toContain("corpus-write-failed");
    expect(deleteCorpusDocumentMock).not.toHaveBeenCalled();
  });

  test("retries when an expired upload intent was reclaimed", async () => {
    existingDecision = {
      id: createSafeId<"caseLawDecision">(),
      metadata: {},
      sourceHash: "older-hash",
      sourceObservedAt: new Date("2026-07-31T11:00:00.000Z"),
      sourceObservationHash: "older-hash",
      sourceObservationOrder: 0n,
      corpusMirrorStatus: "pending",
      redactedAt: null,
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };
    intentStatus = "cleanup";

    const outcome = await processDecision({
      input: decision,
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    expect(outcome).toEqual({
      status: "retryable",
      inserted: false,
      reason: "corpus-write",
    });
    expect(writeCorpusDocumentMock).not.toHaveBeenCalled();
  });

  // bun-types declares `.rejects.toBe` as void, so awaiting it trips
  // type-aware lint; capture the rejection explicitly instead.
  const rejectionFrom = async (): Promise<unknown> =>
    await processDecision({
      input: decision,
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    }).then(
      () => null,
      (error: unknown) => error,
    );

  test("never starts an upload when the row write fails", async () => {
    rowWrite = "fault";

    const rejection = await rejectionFrom();

    // The pipeline's halt logic branches on the error's own type, so the
    // rethrow must surface the driver error, not a Result wrapper.
    expect(rejection).toBeInstanceOf(DatabaseError);
    expect(writeCorpusDocumentMock).not.toHaveBeenCalled();
    expect(deleteCorpusDocumentMock).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  test("does not start an upload when the row write times out", async () => {
    rowWrite = "timeout";

    const rejection = await rejectionFrom();

    expect(rejection).toBeInstanceOf(TimeoutError);
    expect(writeCorpusDocumentMock).not.toHaveBeenCalled();
    expect(deleteCorpusDocumentMock).not.toHaveBeenCalled();
  });
});

describe("runIngestionPipeline — canonical corpus write failure", () => {
  test("holds the cursor so the next cycle retries the decision", async () => {
    writeCorpusDocumentMock.mockImplementationOnce(
      async () => await Promise.reject(new Error("bucket unreachable")),
    );

    const source = caseLawSourceRow({ name: "Canonical source" });

    czNsAdapter.fetchPage = async () =>
      await Promise.resolve(
        Result.ok({ decisions: [decision], nextCursor: "cursor-2" }),
      );

    const result = await runIngestionPipeline({
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
    });

    expect(result.inserted).toBe(1);
    expect(result.s3UploadFailures).toBe(1);
    expect(result.pagesProcessed).toBe(0);
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.haltReason).toContain("corpus write failure(s)");
    expect(persistedCursor).toBe("cursor-1");
    expect(insertedRows).toHaveLength(1);
  });

  test("holds the cursor when bounded contention does not converge", async () => {
    existingDecision = {
      id: createSafeId<"caseLawDecision">(),
      metadata: {},
      sourceHash: decision.rawHash,
      sourceObservedAt: new Date("2026-07-31T12:00:00.000Z"),
      sourceObservationHash: decision.rawHash,
      sourceObservationOrder: 0n,
      corpusMirrorStatus: "settled",
      redactedAt: null,
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };
    mirrorSettlementApplied = false;

    const source = caseLawSourceRow({ name: "Canonical source" });

    czNsAdapter.fetchPage = async () =>
      await Promise.resolve(
        Result.ok({ decisions: [decision], nextCursor: "cursor-2" }),
      );

    const result = await runIngestionPipeline({
      source,
      sourceLease: testSourceLease(source),
      scopedDb,
    });

    expect(result).toMatchObject({
      inserted: 0,
      skipped: 1,
      s3UploadFailures: 0,
      pagesProcessed: 0,
      nextCursor: "cursor-1",
    });
    expect(result.haltReason).toContain("Concurrent decision reconciliation");
    expect(persistedCursor).toBe("cursor-1");
  });
});
