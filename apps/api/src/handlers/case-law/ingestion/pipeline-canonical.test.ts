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
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import {
  caseLawCanonicalPayload,
  processDecision as processDecisionWithDependencies,
  runIngestionPipeline as runIngestionPipelineWithDependencies,
  sanitizeResult,
} from "@/api/handlers/case-law/ingestion/pipeline";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline";
import { createSafeId } from "@/api/lib/branded-types";
import { DatabaseError, TimeoutError } from "@/api/lib/errors/tagged-errors";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { CorpusWriteOutcome } from "@/api/lib/legal-search/corpus-storage";
import * as realCorpusStorage from "@/api/lib/legal-search/corpus-storage";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

/**
 * `canonical` storage mode moves the payload out of Postgres, so what a
 * type cannot check is the ordering: the row and durable upload intent must
 * exist before external I/O, and the row may only point at objects after the
 * fenced write succeeds.
 */

/** Ordered log of the side effects under test, across S3 and the DB. */
const events: string[] = [];
const insertedRows: Record<string, unknown>[] = [];
const updatedDecisionRows: Record<string, unknown>[] = [];

// The double runs the real redundancy decision and fakes only the S3 I/O,
// so a payload the planner refuses is refused here for the same reason it
// would be in production, not because a fixture said so.
const writeCorpusDocumentMock = mock(
  async (
    input: Parameters<typeof realCorpusStorage.writeCorpusDocument>[0],
  ): Promise<CorpusWriteOutcome> => {
    const plan = realCorpusStorage.planCorpusDocumentWrite(input);
    if (plan.type !== "put") {
      events.push(`corpus-skip:${plan.type}`);
      return await Promise.resolve(plan);
    }
    events.push(`corpus-write:${input.documentId}`);
    return await Promise.resolve({ type: "written", written: plan.written });
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

const corpusDependencies = {
  mode: "canonical",
  write: writeCorpusDocumentMock,
} satisfies CaseLawCorpusDependencies;

const processDecision = async (
  options: Parameters<typeof processDecisionWithDependencies>[0],
) =>
  await processDecisionWithDependencies({
    ...options,
    corpus: corpusDependencies,
  });

const runIngestionPipeline = async (
  options: Parameters<typeof runIngestionPipelineWithDependencies>[0],
) =>
  await runIngestionPipelineWithDependencies({
    ...options,
    corpus: corpusDependencies,
  });

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
 * The write the settle path records for `decision`'s canonical payload,
 * derived with the same functions the pipeline uses so the fixture cannot
 * drift from what production would store.
 */
const recordedCorpusWrite = (documentId: string) => {
  const contentHash = realCorpusStorage.corpusContentHash(
    caseLawCanonicalPayload(sanitizeResult(decision)),
  );
  return {
    ...realCorpusStorage.corpusKeys({
      documentId,
      jurisdiction: decision.country,
      contentHash,
    }),
    contentHash,
  };
};

/**
 * Minimal transaction double covering the insert path: the dedup lookup,
 * the slug-collision scan, the decision insert, and the source-cursor
 * update the pipeline runs at the end of a cycle.
 */
const scopedDb: ScopedDb = async (callback) => {
  const tx = {
    // The citation-graph settle the pipeline runs in the same
    // transaction is raw SQL; this suite asserts the decision row, so
    // the statement is accepted and reports nothing settled.
    execute: async () => await Promise.resolve([]),
    query: {
      // drizzle's relational API returns undefined for a miss.
      caseLawDecisions: {
        findFirst: async () => await Promise.resolve(existingDecision),
      },
    },
    select: (selection: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const rows = async () => {
          if (table === caseLawSources && "sourceDescriptor" in selection) {
            return [
              {
                sourceId:
                  insertedRows.at(0)?.["sourceId"] ??
                  existingDecision?.["sourceId"],
                sourceDescriptor: null,
              },
            ];
          }
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
          innerJoin: () => ({
            where: () => ({ limit: () => ({ for: rows }) }),
          }),
          where: () => ({
            limit: rows,
            for: () => ({ limit: rows }),
          }),
        };
      },
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
    const written = recordedCorpusWrite(String(row?.["id"]));
    expect(updatedDecisionRows.at(-1)).toMatchObject({
      fulltext: null,
      sections: null,
      documentAst: null,
      textS3Key: written.textKey,
      normalizedS3Key: written.sectionsKey,
      astS3Key: written.astKey,
      contentHash: written.contentHash,
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
      contentHash: null,
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
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
      contentHash: null,
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
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

  test("stores nothing and settles null pointers for a metadata-only decision", async () => {
    const outcome = await processDecision({
      // A metadata-first observation: identity fields only, the empty-AST
      // placeholder, no fulltext — the shape a deferred-document adapter
      // returns for every listing row.
      input: { ...decision, fulltext: undefined },
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
    expect(events).toContain("corpus-skip:skipped-empty");
    expect(events.filter((e) => e.startsWith("corpus-write:"))).toHaveLength(0);
    const settled = updatedDecisionRows.at(-1);
    expect(settled).toMatchObject({
      corpusMirrorStatus: "settled",
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
      contentHash: null,
    });
    // Nothing in object storage backs this row, so the settle must not
    // trim the Postgres payload columns.
    expect(settled).not.toHaveProperty("fulltext");
    expect(events.at(-1)).toBe("intent-delete");
  });

  test("skips the corpus PUT when a settled row already records the payload", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const recorded = recordedCorpusWrite(decisionId);
    existingDecision = {
      id: decisionId,
      metadata: {},
      // The publisher's raw hash moved (a metadata change) …
      sourceHash: "older-hash",
      sourceObservedAt: new Date("2026-07-31T11:00:00.000Z"),
      sourceObservationHash: "older-hash",
      sourceObservationOrder: 0n,
      // … while the canonical payload the row settled did not.
      corpusMirrorStatus: "settled",
      contentHash: recorded.contentHash,
      textS3Key: recorded.textKey,
      normalizedS3Key: recorded.sectionsKey,
      astS3Key: recorded.astKey,
      redactedAt: null,
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };

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
    expect(events).toContain("corpus-skip:skipped-unchanged");
    expect(events.filter((e) => e.startsWith("corpus-write:"))).toHaveLength(0);
    // The mirror settles back onto the pointers it already held.
    expect(updatedDecisionRows.at(-1)).toMatchObject({
      corpusMirrorStatus: "settled",
      textS3Key: recorded.textKey,
      normalizedS3Key: recorded.sectionsKey,
      astS3Key: recorded.astKey,
      contentHash: recorded.contentHash,
    });
    expect(events.at(-1)).toBe("intent-delete");
  });

  test("a pending mirror settles once and then stops writing", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    existingDecision = {
      id: decisionId,
      metadata: {},
      // The publisher did not move; only the mirror is stuck pending, so
      // the source-hash skip must not swallow the settlement.
      sourceHash: decision.rawHash,
      sourceObservedAt: new Date("2026-07-31T11:00:00.000Z"),
      sourceObservationHash: decision.rawHash,
      sourceObservationOrder: 0n,
      corpusMirrorStatus: "pending",
      contentHash: null,
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
      redactedAt: null,
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };

    const first = await processDecision({
      input: decision,
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    expect(first).toEqual({
      status: "complete",
      inserted: true,
      searchVectorFailed: false,
    });
    // A pending row records no write, so this pass must upload and settle.
    expect(events.filter((e) => e.startsWith("corpus-write:"))).toHaveLength(1);
    expect(updatedDecisionRows.at(-1)).toMatchObject({
      corpusMirrorStatus: "settled",
    });

    // The next crawl pass sees the row the settle produced; with the source
    // unchanged it advances the watermark and touches no corpus state.
    const recorded = recordedCorpusWrite(decisionId);
    existingDecision = {
      ...existingDecision,
      corpusMirrorStatus: "settled",
      contentHash: recorded.contentHash,
      textS3Key: recorded.textKey,
      normalizedS3Key: recorded.sectionsKey,
      astS3Key: recorded.astKey,
    };
    events.length = 0;

    const second = await processDecision({
      input: decision,
      observationOrder: 2n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T13:00:00.000Z"),
    });

    expect(second).toEqual({
      status: "complete",
      inserted: false,
      searchVectorFailed: false,
    });
    expect(events.filter((e) => e.startsWith("corpus-"))).toHaveLength(0);
    expect(events).not.toContain("intent-reserve");
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
