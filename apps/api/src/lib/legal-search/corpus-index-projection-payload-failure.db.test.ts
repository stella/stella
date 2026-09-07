/**
 * A batch whose payloads all fail produces no append, and an append is what
 * normally carries the failures collected beside it to the store. Deferring
 * them to the end of the stream would make the first classification wait out
 * every read in the batch — long enough at the permitted batch size for the
 * leases to expire, after which classification reports `lease_lost`, records
 * no attempt, and an unavailable payload retries forever instead of reaching
 * `blocked`. So they drain on the read window's granularity instead.
 *
 * Every payload here fails without a request: a packed address declares more
 * bytes than the transfer ceiling admits, which the reader refuses before it
 * asks object storage for anything.
 */

import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { CORPUS_PROJECTION_APPEND_COMMIT_MODE } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { executeCorpusProjectionAppendCycle } from "@/api/lib/legal-search/corpus-index-projection-executor";
import { CORPUS_PROJECTION_GENERATION_SCOPE } from "@/api/lib/legal-search/corpus-index-projection-scope";
import { CORPUS_TRANSFER_MAX_BYTES } from "@/api/lib/legal-search/corpus-storage";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const SOURCE_ID = "0198e331-e578-7000-8000-0000000000a1";
const REVISIONS = 8;
const READ_CONCURRENCY = 2;
const EPOCH = 3n;

/** Refused by `readCorpusBytesAt` on its declared length, before any request. */
const OVERSIZE_PACKED_KEY = `pack:legal-corpus/pack.zst@0+${CORPUS_TRANSFER_MAX_BYTES + 1}`;

const documentId = (index: number): string =>
  `0198e331-e578-7000-8000-0000000001${String(index).padStart(2, "0")}`;

const documentRow = (index: number) => ({
  id: toSafeId<"legislationDocument">(documentId(index)),
  sourceId: toSafeId<"legislationSource">(SOURCE_ID),
  eli: `eli/cz/sb/2012/${89 + index}`,
  title: `Zákon č. ${89 + index}/2012 Sb.`,
  country: "CZE",
  language: "cs",
  documentType: "act",
  status: "current",
  effectiveDate: "2014-01-01",
  versionValidFrom: "2014-01-01",
  versionValidTo: null,
  contentHash: "a".repeat(64),
  textS3Key: OVERSIZE_PACKED_KEY,
  projectionEpoch: EPOCH,
});

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let transactionCount = 0;

const runInTransaction = async <TResult>(
  operation: (tx: Transaction) => Promise<TResult>,
): Promise<TResult> => {
  transactionCount += 1;
  return await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );
};

const unusedIngest = async () =>
  panic("A cycle with no readable payload must not reach the engine");

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(corpusIndexGenerations).values({
      ...TARGET,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(MANIFEST),
      status: "building",
    });
    await db.insert(legislationSources).values({
      id: toSafeId<"legislationSource">(SOURCE_ID),
      adapterKey: "test-collection",
      name: "Test collection",
      descriptor: null,
    });

    const rows = Array.from({ length: REVISIONS }, (_unused, index) =>
      documentRow(index),
    );
    await db.insert(legislationDocuments).values(rows);

    // The desired state has to name the fingerprint and index the reservation
    // will lease against, so derive both the way the desired-state writer does
    // rather than pinning literals that would drift with the manifest.
    await db.insert(corpusIndexProjectionStates).values(
      rows.map((row) => {
        const descriptor = deriveCorpusIndexProjectionDescriptor(
          MANIFEST,
          // The same projection of the row the material read performs.
          legislationProjectionInputFromCanonical({
            documentId: row.id,
            sourceId: row.sourceId,
            jurisdiction: row.country,
            language: row.language,
            documentType: row.documentType,
            contentHash: row.contentHash,
            title: row.title,
            status: row.status,
            effectiveDate: row.effectiveDate,
            versionValidFrom: row.versionValidFrom,
            versionValidTo: row.versionValidTo,
            eli: row.eli,
            sourceDescriptor: null,
          }),
        );
        if (descriptor.action !== "upsert") {
          return panic("Seeded legislation row is not projectable");
        }
        return {
          family: TARGET.family,
          generation: TARGET.generation,
          entityId: String(row.id),
          desiredAction: "upsert" as const,
          desiredEpoch: EPOCH,
          desiredFingerprint: descriptor.fingerprint,
          desiredIndexId: descriptor.indexId,
        };
      }),
    );
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("unreadable payloads are persisted as they are read, not once the batch drains", async () => {
  const result = await executeCorpusProjectionAppendCycle({
    runInTransaction,
    client: {
      ingestCommittedBatch: unusedIngest,
      ingestQueuedBatch: unusedIngest,
    },
    commitMode: CORPUS_PROJECTION_APPEND_COMMIT_MODE.published,
    family: TARGET.family,
    generation: TARGET.generation,
    scope: CORPUS_PROJECTION_GENERATION_SCOPE,
    limit: REVISIONS,
    leaseMs: 600_000,
    payloadReadConcurrency: READ_CONCURRENCY,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
  });

  expect(result.reserved).toBe(REVISIONS);
  expect(result.blocked).toBe(REVISIONS);
  expect(result.requestCount).toBe(0);

  const states = await db
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      workStatus: corpusIndexProjectionStates.workStatus,
      lastFailureKind: corpusIndexProjectionStates.lastFailureKind,
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.generation, TARGET.generation));
  expect(states).toHaveLength(REVISIONS);
  expect(
    states.every(
      ({ workStatus, lastFailureKind }) =>
        workStatus === "blocked" && lastFailureKind === "revision_too_large",
    ),
  ).toBe(true);

  // Reservation, material read, then one classification per read window. A
  // cycle that deferred every failure to the end would open three or four
  // transactions in total however many revisions failed.
  expect(transactionCount).toBeGreaterThanOrEqual(
    2 + REVISIONS / READ_CONCURRENCY,
  );
});
