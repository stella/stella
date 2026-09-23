import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { DatabaseError, TimeoutError } from "@/api/lib/errors/tagged-errors";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  CorpusPackError,
  decodePackFooter,
} from "@/api/lib/legal-search/corpus-pack";
import type { EncodedPack } from "@/api/lib/legal-search/corpus-pack";
import type { putCorpusPacks } from "@/api/lib/legal-search/corpus-pack-writer";
import * as realCorpusStorage from "@/api/lib/legal-search/corpus-storage";
import { partialObservationFromMetadata } from "@/api/lib/legal-search/ingestion-normalization";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";

/**
 * `canonical` storage mode moves the payload out of Postgres, so what a
 * type cannot check is the ordering: the row and durable upload intent must
 * exist before external I/O, and the row may only point at a pack's members
 * after that pack is durable.
 */

/** Ordered log of the side effects under test, across S3 and the DB. */
/** A pack that does not decode fails the test rather than a case in it. */
const unwrapPackFooter = (
  decoded: Awaited<ReturnType<typeof decodePackFooter>>,
): Awaited<ReturnType<typeof decodePackFooter>> extends Result<
  infer Footer,
  unknown
>
  ? Footer
  : never => {
  if (Result.isError(decoded)) {
    throw decoded.error;
  }
  return decoded.value;
};

const events: string[] = [];
const insertedRows: Record<string, unknown>[] = [];
const updatedDecisionRows: Record<string, unknown>[] = [];

/** Every pack the batches under test handed to the transfer. */
const transferredPacks: EncodedPack[] = [];

/** The documents a pack carries members for, in the order it carries them. */
const packedDocumentIds = (pack: EncodedPack): string[] => [
  ...new Set(pack.entries.map(({ member }) => member.documentId)),
];

// The double fakes only the transfer. The batch still runs the real
// redundancy decision and encodes a real pack, so a payload the planner
// refuses contributes no member here for the same reason it would in
// production, not because a fixture said so.
const putPacksMock = mock(
  async ({
    packs,
  }: Parameters<typeof putCorpusPacks>[0]): Promise<
    Result<void, CorpusPackError>
  > => {
    for (const pack of packs) {
      transferredPacks.push(pack);
      events.push(`corpus-pack:${packedDocumentIds(pack).join(",")}`);
    }
    return await Promise.resolve(Result.ok(undefined));
  },
);

/** A transfer that fails the way an unreachable bucket does. */
const failTheTransfer = () => {
  putPacksMock.mockImplementationOnce(async () => {
    events.push("corpus-pack-failed");
    return await Promise.resolve(
      Result.err(new CorpusPackError({ message: "bucket unreachable" })),
    );
  });
};

/** Row updates that repointed the mirror at durable payloads. */
const settledDecisionRows = () =>
  updatedDecisionRows.filter(
    (updated) => updated["corpusMirrorStatus"] === "settled",
  );

const corpusDependencies = {
  mode: "canonical",
  transfer: { layout: "packs", putPacks: putPacksMock },
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
  transferredPacks.length = 0;
  persistedCursor = undefined;
  rowWrite = "ok";
  existingDecision = undefined;
  mirrorSettlementApplied = true;
  intentStatus = "active";
  putPacksMock.mockClear();
});

const decision: IngestionResult = {
  caseNumber: "X/1/2026",
  court: "Test Court",
  country: "SVK",
  language: "sk",
  fulltext: "Rozhodnutie o veci samej.",
  metadata: {},
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  rawHash: "raw-hash",
  documentAst: {},
};

/**
 * The object-keyed write a row settled before packs existed, and the content
 * hash `decision`'s payload settles under either way. Derived with the same
 * functions the pipeline uses so the fixture cannot drift from what
 * production would store.
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

/** The decision this pass works on: the row it inserted, or the one it found. */
const processedDecisionId = () =>
  insertedRows.at(-1)?.["id"] ?? existingDecision?.["id"];

/**
 * Minimal transaction double covering the insert path: the dedup lookup,
 * the slug-collision scan, the decision insert, the batch's reservation of
 * every decision it packs, and the source-cursor update the pipeline runs at
 * the end of a cycle.
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
          if ("holdsDocument" in selection) {
            // The document-less payload guard: the row holds no document,
            // and this refresh's empty payload differs from what it holds.
            return [{ holdsDocument: false, differs: true }];
          }
          if ("id" in selection && "redactedAt" in selection) {
            // The batch reserves by locking every decision it packs and
            // keeping the ones no redaction has claimed.
            return [{ id: processedDecisionId(), redactedAt: null }];
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
            // The batch's reservation awaits `.for("share")` for the whole
            // page; the single-row fences chain `.limit(1)` onto it.
            for: (): unknown => Object.assign(rows(), { limit: rows }),
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      // A batch reserves its whole page in one statement, so the values are
      // a list wherever more than one decision contributes.
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const inserted = Array.isArray(values) ? values : [values];
        const outcome = table === caseLawDecisions ? rowWrite : "ok";
        if (outcome === "ok") {
          if (table === caseLawDecisions) {
            events.push("row-insert");
            insertedRows.push(...inserted);
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
          return await Promise.resolve(
            inserted.map((row) => ({
              id: row["id"],
              decisionId: row["decisionId"],
            })),
          );
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
      expect.stringContaining("corpus-pack:"),
    ]);

    const [row] = insertedRows;
    const decisionId = String(row?.["id"]);
    expect(events[2]).toBe(`corpus-pack:${decisionId}`);
    expect(row).toMatchObject({
      fulltext: decision.fulltext,
      corpusMirrorStatus: "pending",
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
      contentHash: null,
    });

    // One pack left the process, and it carries this decision's three
    // payloads — the transfer a page shares, here with a page of one.
    expect(transferredPacks).toHaveLength(1);
    const pack = transferredPacks.at(0) ?? expect.unreachable();
    const footer = unwrapPackFooter(await decodePackFooter(pack.bytes));
    expect(
      footer.members.map(({ documentId, kind }) => ({ documentId, kind })),
    ).toEqual([
      { documentId: decisionId, kind: "text" },
      { documentId: decisionId, kind: "sections" },
      { documentId: decisionId, kind: "ast" },
    ]);

    // One settlement, and it is the last thing to touch the row: the
    // negative form of this assertion is what the failure cases below use.
    expect(settledDecisionRows()).toHaveLength(1);
    const settled = updatedDecisionRows.at(-1) ?? expect.unreachable();
    expect(settled).toMatchObject({
      fulltext: null,
      sections: null,
      documentAst: null,
      contentHash: recordedCorpusWrite(decisionId).contentHash,
      corpusMirrorStatus: "settled",
    });
    // The row addresses members of that pack, not keys of its own.
    for (const column of [
      "textS3Key",
      "normalizedS3Key",
      "astS3Key",
    ] as const) {
      expect(parseCorpusLocation(String(settled[column]))).toMatchObject({
        type: "packed",
        packKey: pack.packKey,
      });
    }
    expect(events.at(-1)).toBe("intent-delete");
  });

  test("keeps a readable pending row when the corpus write fails", async () => {
    failTheTransfer();

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
    expect(events).toContain("corpus-pack-failed");
    // Nothing became durable, so nothing may point at it.
    expect(transferredPacks).toEqual([]);
    expect(settledDecisionRows()).toEqual([]);
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
    // One pack, carrying the repaired decision's members and nothing else.
    expect(transferredPacks).toHaveLength(1);
    expect(
      packedDocumentIds(transferredPacks.at(0) ?? expect.unreachable()),
    ).toEqual([decisionId]);
    expect(updatedDecisionRows[0]).toMatchObject({
      sourceHash: "recovered-detail-hash",
      sourceObservationHash: "listing-only-replay-hash",
      sourceObservationOrder: 2n,
    });
    // The row already holds the payload it is replaying, so the claim does
    // not copy it back in; the pack above carries it from the row.
    for (const column of ["fulltext", "sections", "documentAst"]) {
      expect(updatedDecisionRows[0]).not.toHaveProperty(column);
    }
    expect(updatedDecisionRows[0]).not.toHaveProperty("caseNumber");
    expect(updatedDecisionRows[0]).not.toHaveProperty("metadata");
    expect(updatedDecisionRows[0]).not.toHaveProperty("sourceRawS3Key");
    expect(updatedDecisionRows.at(-1)).toMatchObject({
      corpusMirrorStatus: "settled",
      fulltext: null,
    });
  });

  test("keeps the served payload when the failed write was a refresh", async () => {
    // A refresh of a row whose payload columns are NULL has nothing to fall
    // back on: the decision is served from whatever its pointers address.
    // A transfer that failed must therefore leave those pointers alone.
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
    failTheTransfer();

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
    expect(events).toContain("corpus-pack-failed");
    expect(transferredPacks).toEqual([]);
    expect(settledDecisionRows()).toEqual([]);
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
    // The pack goes out before any row settles, so a reclaimed reservation
    // is caught where it matters: the row is never repointed at members this
    // pass no longer owns, and the decision comes back for the next batch.
    expect(settledDecisionRows()).toEqual([]);
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
    // An empty payload has nothing to store, so nothing is transferred or
    // reserved: the row is written settled, with no pointers, at once.
    expect(transferredPacks).toEqual([]);
    expect(events).not.toContain("intent-reserve");
    expect(updatedDecisionRows).toEqual([]);
    const inserted = insertedRows.at(0);
    expect(inserted).toMatchObject({
      corpusMirrorStatus: "settled",
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
      contentHash: null,
    });
    // Nothing in object storage backs this row, so its Postgres payload
    // columns are what it holds.
    expect(inserted?.["documentAst"]).toEqual(decision.documentAst);
    // A row a reader cannot open is stored unpublished under the packed
    // layout too: the marker is decided by the write that proves the row
    // holds no document, never by where a payload would have lived.
    expect(
      partialObservationFromMetadata(inserted?.["metadata"]),
    ).toMatchObject({ isListingOnly: true });
  });

  test("leaves a settled row's payload alone when only the publisher page moved", async () => {
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
    // An unchanged payload contributes no member either.
    expect(transferredPacks).toEqual([]);
    // Nor does it touch the row's payload or pointers: the metadata refresh
    // is the only write, so the document is not copied back into the row
    // and trimmed out again.
    expect(updatedDecisionRows).toHaveLength(1);
    for (const column of [
      "fulltext",
      "sections",
      "documentAst",
      "corpusMirrorStatus",
      "textS3Key",
      "normalizedS3Key",
      "astS3Key",
      "contentHash",
    ]) {
      expect(updatedDecisionRows.at(0)).not.toHaveProperty(column);
    }
    expect(updatedDecisionRows.at(0)).toMatchObject({
      sourceHash: decision.rawHash,
    });
    expect(events).not.toContain("intent-reserve");
  });

  test("moves an unchanged payload whose jurisdiction moved", async () => {
    // The corpus keys carry the jurisdiction partition, so the same document
    // restated under another country is not the write the row records: it
    // must land under the new partition rather than be kept where it was.
    const decisionId = createSafeId<"caseLawDecision">();
    const recorded = recordedCorpusWrite(decisionId);
    existingDecision = {
      id: decisionId,
      metadata: {},
      sourceHash: "older-hash",
      sourceObservedAt: new Date("2026-07-31T11:00:00.000Z"),
      sourceObservationHash: "older-hash",
      sourceObservationOrder: 0n,
      corpusMirrorStatus: "settled",
      contentHash: recorded.contentHash,
      textS3Key: recorded.textKey,
      normalizedS3Key: recorded.sectionsKey,
      astS3Key: recorded.astKey,
      redactedAt: null,
      sourceRawS3Key: null,
      sourceRawContentType: null,
    };
    const moved = { ...decision, country: "CZE" };
    // Not vacuous: the payload is the one the row records.
    expect(
      realCorpusStorage.corpusContentHash(
        caseLawCanonicalPayload(sanitizeResult(moved)),
      ),
    ).toBe(recorded.contentHash);

    await processDecision({
      input: moved,
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    expect(transferredPacks).toHaveLength(1);
    expect(updatedDecisionRows.at(0)).toMatchObject({
      corpusMirrorStatus: "pending",
    });
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
    // A pending row records no write, so this pass must pack and settle.
    expect(transferredPacks).toHaveLength(1);
    const settled = updatedDecisionRows.at(-1) ?? expect.unreachable();
    expect(settled).toMatchObject({ corpusMirrorStatus: "settled" });

    // The next crawl pass sees the row the settle produced — the addresses
    // it wrote, not a recomputation of them; with the source unchanged it
    // advances the watermark and touches no corpus state.
    existingDecision = {
      ...existingDecision,
      corpusMirrorStatus: "settled",
      contentHash: settled["contentHash"],
      textS3Key: settled["textS3Key"],
      normalizedS3Key: settled["normalizedS3Key"],
      astS3Key: settled["astS3Key"],
    };
    events.length = 0;
    transferredPacks.length = 0;

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
    expect(transferredPacks).toEqual([]);
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
    expect(putPacksMock).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  test("does not start an upload when the row write times out", async () => {
    rowWrite = "timeout";

    const rejection = await rejectionFrom();

    expect(rejection).toBeInstanceOf(TimeoutError);
    expect(putPacksMock).not.toHaveBeenCalled();
  });
});

describe("processDecision — a refresh whose raw-source write failed", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("reports the raw-source retry although the pack settled", async () => {
    // The update kept its old `sourceHash` so the next pass re-observes the
    // decision. A single decision is its own batch, and its corpus outcome
    // is the whole answer only if nothing else is owed: reporting complete
    // here would advance the cursor past a raw source that never landed.
    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });
    existingDecision = {
      id: createSafeId<"caseLawDecision">(),
      metadata: {},
      sourceHash: "older-hash",
      sourceObservedAt: new Date("2026-07-31T11:00:00.000Z"),
      sourceObservationHash: "older-hash",
      sourceObservationOrder: 0n,
      corpusMirrorStatus: "settled",
      contentHash: null,
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
      redactedAt: null,
      sourceRawS3Key: "case-law/raw/older",
      sourceRawContentType: "text/html",
    };

    const outcome = await processDecision({
      input: { ...decision, sourceRaw: "<html></html>" },
      observationOrder: 1n,
      sourceId: createSafeId<"caseLawSource">(),
      scopedDb,
      observedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    // The corpus write itself succeeded, so the reason names the retry the
    // page-batch path reports for the same failure.
    expect(transferredPacks).toHaveLength(1);
    expect(settledDecisionRows()).toHaveLength(1);
    expect(outcome).toEqual({
      status: "retryable",
      inserted: true,
      reason: "corpus-write",
    });
  });
});

describe("runIngestionPipeline — canonical corpus write failure", () => {
  test("holds the cursor so the next cycle retries the decision", async () => {
    failTheTransfer();

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
