import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { confirmCorpusProjectionAppends } from "@/api/lib/legal-search/corpus-index-projection-confirmation";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  censusCorpusProjectionRevisions,
  corpusIndexUnknownAppendBarrierAt,
  corpusProjectionRevisionsQuery,
  deleteCorpusProjectionRevisions,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { executeCorpusProjectionAppendCycle } from "@/api/lib/legal-search/corpus-index-projection-executor";
import { CORPUS_PROJECTION_GENERATION_SCOPE } from "@/api/lib/legal-search/corpus-index-projection-scope";
import { writeCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { startFakeS3, type FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = { family: "legislation", generation: "legislation_v2" } as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const SOURCE_ID = "0198e331-e578-7000-8000-0000000000c1";
const DOCUMENT_ID = "0198e331-e578-7000-8000-0000000000c2";
const EPOCH = 5n;
const TEXT = Array.from(
  { length: 11 },
  (_, index) => `${index}\n${"a".repeat(980_000)}\n\n`,
).join("");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let fake: FakeS3;

const runInTransaction = async <TResult>(
  operation: (tx: Transaction) => Promise<TResult>,
): Promise<TResult> =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

/** What the fake engine has published, by projection revision. */
const publishedCounts = new Map<string, number>();

const censusClient = {
  aggregate: async ({ query }: { query: string }) =>
    Result.ok({
      projection_revisions: {
        buckets: Array.from(publishedCounts, ([key, doc_count]) => ({
          key,
          doc_count,
        })).filter(({ key }) => query.includes(`"${key}"`)),
        doc_count_error_upper_bound: 0,
        sum_other_doc_count: 0,
      },
    }),
};

const runCycle = async (
  ingestQueuedBatch: (
    indexId: string,
    ndjson: string,
  ) => Promise<Result<void, CorpusIndexError>>,
) =>
  await executeCorpusProjectionAppendCycle({
    runInTransaction,
    client: {
      ingestQueuedBatch: async (indexId, ndjson) => {
        const result = await ingestQueuedBatch(indexId, ndjson);
        if (result.isErr()) {
          return result;
        }
        for (const line of ndjson.split("\n")) {
          const { projection_revision } = JSON.parse(line);
          if (typeof projection_revision !== "string") {
            panic("Accepted document has no projection revision");
          }
          publishedCounts.set(
            projection_revision,
            (publishedCounts.get(projection_revision) ?? 0) + 1,
          );
        }
        return result;
      },
    },
    family: TARGET.family,
    generation: TARGET.generation,
    scope: CORPUS_PROJECTION_GENERATION_SCOPE,
    limit: 1,
    leaseMs: 600_000,
    payloadReadConcurrency: 1,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
  });

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
      adapterKey: "multipart-test",
      name: "Multipart test",
      descriptor: null,
    });
    const written = await writeCorpusDocument({
      documentId: DOCUMENT_ID,
      jurisdiction: "CZE",
      text: TEXT,
      sections: null,
      ast: null,
      stored: null,
    });
    if (written.type !== "written") {
      panic("Seeded corpus payload was not written");
    }
    const row = {
      id: toSafeId<"legislationDocument">(DOCUMENT_ID),
      sourceId: toSafeId<"legislationSource">(SOURCE_ID),
      eli: "eli/cz/sb/2015/100",
      title: "Zákon č. 100/2015 Sb.",
      country: "CZE",
      language: "cs",
      documentType: "act",
      status: "current",
      effectiveDate: "2016-01-01",
      versionValidFrom: "2016-01-01",
      versionValidTo: null,
      contentHash: written.written.contentHash,
      textS3Key: written.written.textKey,
      normalizedS3Key: written.written.sectionsKey,
      astS3Key: null,
      projectionEpoch: EPOCH,
    };
    expect(row.astS3Key).toBeNull();
    await db.insert(legislationDocuments).values(row);
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
      panic("Seeded legislation row is not projectable");
    }
    await db.insert(corpusIndexProjectionStates).values({
      family: TARGET.family,
      generation: TARGET.generation,
      entityId: String(row.id),
      desiredAction: "upsert",
      desiredEpoch: EPOCH,
      desiredFingerprint: descriptor.fingerprint,
      desiredIndexId: descriptor.indexId,
    });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
  fake.stop();
});

test("an oversized act without an AST is accepted after the last part and applied once searchable", async () => {
  const accepted: Record<string, unknown>[][] = [];
  const result = await runCycle(async (_indexId, ndjson) => {
    accepted.push(ndjson.split("\n").map((line) => JSON.parse(line)));
    const intent = await db
      .select({ status: corpusIndexProjectionIntents.status })
      .from(corpusIndexProjectionIntents);
    expect(intent).toEqual([{ status: "append_started" }]);
    return Result.ok();
  });

  const documents = accepted.flat();
  expect(result.requestCount).toBeGreaterThan(1);
  expect(result.accepted).toBe(1);
  expect(documents.length).toBeGreaterThan(1);
  expect(documents.map(({ text }) => text).join("")).toBe(TEXT);
  expect(documents.filter(({ is_opening }) => is_opening)).toHaveLength(1);
  expect(
    new Set(documents.map(({ projection_revision }) => projection_revision))
      .size,
  ).toBe(1);
  const intents = await db
    .select({
      status: corpusIndexProjectionIntents.status,
      expectedDocumentCount: corpusIndexProjectionIntents.expectedDocumentCount,
    })
    .from(corpusIndexProjectionIntents);
  expect(intents).toEqual([
    { status: "append_committed", expectedDocumentCount: documents.length },
  ]);

  const confirmed = await confirmCorpusProjectionAppends({
    runInTransaction,
    client: censusClient,
    family: TARGET.family,
    generation: TARGET.generation,
    limit: 8,
  });
  expect(confirmed).toMatchObject({ status: "completed", applied: 1 });
  expect(
    await db
      .select({ status: corpusIndexProjectionIntents.status })
      .from(corpusIndexProjectionIntents),
  ).toEqual([{ status: "applied" }]);
});

test("a later part failure leaves the whole revision pending cleanup", async () => {
  // The second fixture is added only after the successful revision has left
  // the work queue, keeping this test's accepted rows distinct.
  const nextId = "0198e331-e578-7000-8000-0000000000c3";
  const original = await db
    .select()
    .from(legislationDocuments)
    .where(
      eq(legislationDocuments.id, toSafeId<"legislationDocument">(DOCUMENT_ID)),
    );
  const row = original.at(0) ?? panic("Missing seeded legislation row");
  await db.insert(legislationDocuments).values({
    ...row,
    id: toSafeId<"legislationDocument">(nextId),
    eli: "eli/cz/sb/2015/101",
  });
  const nextDescriptor = deriveCorpusIndexProjectionDescriptor(
    MANIFEST,
    legislationProjectionInputFromCanonical({
      documentId: toSafeId<"legislationDocument">(nextId),
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
      eli: "eli/cz/sb/2015/101",
      sourceDescriptor: null,
      ...EFFECTIVE_CONSOLIDATION,
    }),
  );
  if (nextDescriptor.action !== "upsert") {
    panic("Second legislation row is not projectable");
  }
  await db.insert(corpusIndexProjectionStates).values({
    family: TARGET.family,
    generation: TARGET.generation,
    entityId: nextId,
    desiredAction: "upsert",
    desiredEpoch: EPOCH,
    desiredFingerprint: nextDescriptor.fingerprint,
    desiredIndexId: nextDescriptor.indexId,
  });
  let accepted: Record<string, unknown>[] = [];
  const partStarts: Date[] = [];
  let calls = 0;
  const result = await runCycle(async (_indexId, ndjson) => {
    calls += 1;
    const started = await db
      .select({ appendStartedAt: corpusIndexProjectionIntents.appendStartedAt })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.entityId, nextId));
    const start = started.at(0)?.appendStartedAt;
    if (start === null || start === undefined) {
      panic("Multipart request has no durable start");
    }
    partStarts.push(start);
    if (calls > 1) {
      return Result.err(
        new CorpusIndexError({ message: "second part failed" }),
      );
    }
    accepted.push(...ndjson.split("\n").map((line) => JSON.parse(line)));
    await Bun.sleep(10);
    return Result.ok();
  });

  expect(calls).toBe(2);
  expect(partStarts[1]?.getTime()).toBeGreaterThan(
    partStarts[0]?.getTime() ?? Infinity,
  );
  expect(accepted.length).toBeGreaterThan(0);
  expect(result.status).toBe("append_unknown");
  expect(result.unknownCleanupPending).toBe(1);
  const intents = await db
    .select({
      entityId: corpusIndexProjectionIntents.entityId,
      status: corpusIndexProjectionIntents.status,
      expectedDocumentCount: corpusIndexProjectionIntents.expectedDocumentCount,
      appendStartedAt: corpusIndexProjectionIntents.appendStartedAt,
      cleanupNotBefore: corpusIndexProjectionIntents.cleanupNotBefore,
    })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.entityId, nextId));
  expect(intents).toHaveLength(1);
  expect(intents[0]?.status).toBe("cleanup_pending");
  expect(intents[0]?.expectedDocumentCount).toBeNull();
  expect(intents[0]?.appendStartedAt).toEqual(partStarts[1]);
  expect(intents[0]?.cleanupNotBefore).toEqual(
    corpusIndexUnknownAppendBarrierAt(
      partStarts[1] ?? panic("Missing last part start"),
      MANIFEST,
    ),
  );

  const revision = toSafeId<"corpusIndexProjectionIntent">(
    String(accepted.at(0)?.["projection_revision"]),
  );
  const indexId = nextDescriptor.indexId;
  const indexed = {
    aggregate: async ({ query }: { query: string }) => {
      expect(query).toBe(corpusProjectionRevisionsQuery([revision]));
      return Result.ok({
        projection_revisions: {
          buckets:
            accepted.length === 0
              ? []
              : [{ key: revision, doc_count: accepted.length }],
          doc_count_error_upper_bound: 0,
          sum_other_doc_count: 0,
        },
      });
    },
    deleteByQuery: async (targetIndexId: string, query: string) => {
      expect(targetIndexId).toBe(indexId);
      expect(query).toBe(corpusProjectionRevisionsQuery([revision]));
      accepted = accepted.filter(
        ({ projection_revision }) => projection_revision !== revision,
      );
      return Result.ok({ opstamp: 1, createdAt: Temporal.Now.instant() });
    },
  };
  const beforeCleanup = await censusCorpusProjectionRevisions({
    client: indexed,
    indexId,
    revisions: [revision],
  });
  expect(
    beforeCleanup.isOk() && beforeCleanup.value.present[0]?.documentCount,
  ).toBeGreaterThan(0);
  const deleted = await deleteCorpusProjectionRevisions({
    client: indexed,
    indexId,
    revisions: [revision],
  });
  expect(deleted.isOk()).toBe(true);
  const afterCleanup = await censusCorpusProjectionRevisions({
    client: indexed,
    indexId,
    revisions: [revision],
  });
  expect(afterCleanup).toEqual(Result.ok({ present: [], missing: [revision] }));
});
