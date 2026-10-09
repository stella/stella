/**
 * The lease start margin stops the cycle, driven through the exported cycle
 * rather than a replica of its loop.
 *
 * Past the margin the deadline branch is true on every advance, so a cycle
 * that keeps buffering emits one request per revision — a batch start, an
 * ingest round trip and a commit each, for what belongs in one capful. The
 * lease here is the shortest the store admits, which is well inside the
 * margin, so the very first revision is margin-led: one request, then the
 * cycle stops and leaves the rest reserved.
 *
 * Payloads are served by the in-process object store, so the reads, the
 * decode and the build are the real ones.
 */

import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { CORPUS_PROJECTION_LEASE_MIN_MS } from "@/api/lib/legal-search/corpus-index-projection-store";
import { writeCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const SOURCE_ID = "0198e331-e578-7000-8000-0000000000b1";
const REVISIONS = 6;
const EPOCH = 4n;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let fake: FakeS3;
const ingested: number[] = [];

const runInTransaction = async <TResult>(
  operation: (tx: Transaction) => Promise<TResult>,
): Promise<TResult> =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

const documentId = (index: number): string =>
  `0198e331-e578-7000-8000-0000000002${String(index).padStart(2, "0")}`;

/**
 * A row whose payload really is in the object store, so the cycle's read,
 * decode and build are the production ones.
 */
const seedDocumentRow = async (index: number) => {
  const id = documentId(index);
  const written = await writeCorpusDocument({
    documentId: id,
    jurisdiction: "CZE",
    text: `Zákon číslo ${index}. `.repeat(40),
    sections: null,
    ast: null,
    stored: null,
  });
  if (written.type !== "written") {
    return panic("Seeded corpus payload was not written");
  }
  return {
    id: toSafeId<"legislationDocument">(id),
    sourceId: toSafeId<"legislationSource">(SOURCE_ID),
    eli: `eli/cz/sb/2013/${100 + index}`,
    title: `Zákon č. ${100 + index}/2013 Sb.`,
    country: "CZE",
    language: "cs",
    documentType: "act",
    status: "current",
    effectiveDate: "2014-01-01",
    versionValidFrom: "2014-01-01",
    versionValidTo: null,
    contentHash: written.written.contentHash,
    textS3Key: written.written.textKey,
    normalizedS3Key: written.written.sectionsKey,
    astS3Key: written.written.astKey,
    projectionEpoch: EPOCH,
  };
};

beforeAll(
  async () => {
    fake = startFakeS3();
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
      adapterKey: "margin-stop-collection",
      name: "Margin stop collection",
      descriptor: null,
    });

    const rows = [];
    for (const index of Array.from({ length: REVISIONS }, (_u, i) => i)) {
      rows.push(await seedDocumentRow(index));
    }
    await db.insert(legislationDocuments).values(rows);

    await db.insert(corpusIndexProjectionStates).values(
      rows.map((row) => {
        const descriptor = deriveCorpusIndexProjectionDescriptor(
          MANIFEST,
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
            ...EFFECTIVE_CONSOLIDATION,
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
  fake.stop();
});

test("a lease inside the start margin appends once and stops", async () => {
  const revisionCounts = new Map<string, number>();
  const result = await executeCorpusProjectionAppendCycle({
    runInTransaction,
    client: {
      ingestCommittedBatch: async (_indexId: string, ndjson: string) => {
        const lines = ndjson.split("\n");
        ingested.push(lines.length);
        for (const line of lines) {
          const { projection_revision } = JSON.parse(line);
          if (typeof projection_revision !== "string") {
            panic("Accepted document has no projection revision");
          }
          revisionCounts.set(
            projection_revision,
            (revisionCounts.get(projection_revision) ?? 0) + 1,
          );
        }
        return await Promise.resolve(Result.ok());
      },
      ingestQueuedBatch: async () =>
        panic("Projection append must wait for publication"),
      aggregate: async ({ query }) =>
        Result.ok({
          projection_revisions: {
            buckets: Array.from(revisionCounts, ([key, doc_count]) => ({
              key,
              doc_count,
            })).filter(({ key }) => query.includes(`"${key}"`)),
            doc_count_error_upper_bound: 0,
            sum_other_doc_count: 0,
          },
        }),
    },
    commitMode: CORPUS_PROJECTION_APPEND_COMMIT_MODE.queued,
    family: TARGET.family,
    generation: TARGET.generation,
    scope: CORPUS_PROJECTION_GENERATION_SCOPE,
    limit: REVISIONS,
    // The shortest lease the store admits, so every advance is inside the
    // 65s start margin and the first revision is already margin-led.
    leaseMs: CORPUS_PROJECTION_LEASE_MIN_MS,
    payloadReadConcurrency: 2,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
  });

  expect(result.reserved).toBe(REVISIONS);
  // One append, not one per revision: the whole point of the stop.
  expect(result.requestCount).toBe(1);
  expect(ingested).toEqual([1]);
  expect(result.applied).toBe(1);

  // The rest keep their reservations rather than paying a cancellation
  // statement each; they are inside the margin, so they come back on their own.
  expect(result.cancelled).toBe(0);
});
