import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_INDEX_UNPROVEN_APPEND_INTENT_STATUSES } from "@/api/lib/legal-search/corpus-index-projection-contract";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES,
  CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
  corpusProjectionAppendIngestBudgetMs,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { executeCorpusProjectionAppendCycle } from "@/api/lib/legal-search/corpus-index-projection-executor";
import {
  CORPUS_PROJECTION_UNPROVEN_BYTES_BUDGET_MAX,
  CORPUS_PROJECTION_UNPROVEN_BYTES_BUDGET_MIN,
  readBackpressuredCorpusProjectionIndexesTx,
  validateCorpusProjectionUnprovenBytesBudget,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const INGEST_BUDGET_MS = corpusProjectionAppendIngestBudgetMs(MANIFEST);
const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-0000000008f1",
);
const EPOCH = 3n;
const PAYLOAD = { text: "A published act.", ast: null } as const;
const BUDGET = CORPUS_PROJECTION_UNPROVEN_BYTES_BUDGET_MIN;
/** Slack for the wall clock between a row's write and the cycle's read. */
const CLOCK_SLACK_MS = 10_000;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let nextDocument = 1;

const seedEntities = async (count: number) => {
  const rows = Array.from({ length: count }, () => {
    const index = nextDocument;
    nextDocument += 1;
    return {
      id: toSafeId<"legislationDocument">(
        `0198e331-e578-7000-8000-${String(index).padStart(12, "0")}`,
      ),
      sourceId: SOURCE_ID,
      eli: `eli/cz/sb/2017/${index}`,
      title: `Act ${index}`,
      country: "CZE",
      language: "cs",
      documentType: "act",
      status: "current",
      effectiveDate: "2017-01-01",
      versionValidFrom: "2017-01-01",
      versionValidTo: null,
      contentHash: "b".repeat(64),
      textS3Key: `test-corpus/${index}`,
      projectionEpoch: EPOCH,
    };
  });
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
        ...TARGET,
        entityId: String(row.id),
        desiredAction: "upsert" as const,
        desiredEpoch: EPOCH,
        desiredFingerprint: descriptor.fingerprint,
        desiredIndexId: descriptor.indexId,
      };
    }),
  );
  return rows.map(({ id }) => String(id));
};

const nth = (entityIds: readonly string[], index: number) =>
  entityIds.at(index) ?? panic("Not enough seeded entities");

const stateOf = async (entityId: string) =>
  (
    await db
      .select()
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, entityId))
  ).at(0) ?? panic("Seeded entity has no state");

/**
 * An unproven revision another chain, or the previous release, left in the
 * entity's index. `appendBytes: null` is a row the previous release started.
 */
type UnprovenRevision = {
  appendBytes: number | null;
  revisionCount: number;
} & (
  | { status: "append_started" }
  | { status: "append_committed"; barrierInMs: number }
);

const insertUnprovenRevision = async (
  entityId: string,
  revision: UnprovenRevision,
) => {
  const state = await stateOf(entityId);
  const common = {
    id: toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7()),
    ...TARGET,
    entityId,
    epoch: state.desiredEpoch,
    fingerprint: state.desiredFingerprint ?? panic("No fingerprint"),
    indexId: state.desiredIndexId ?? panic("No index"),
    appendStartedAt: sql`clock_timestamp()`,
    appendRequestRevisionCount: revision.revisionCount,
    appendBytes: revision.appendBytes,
  };
  switch (revision.status) {
    case "append_started":
      await db.insert(corpusIndexProjectionIntents).values({
        ...common,
        status: revision.status,
        leaseToken: Bun.randomUUIDv7(),
        leaseExpiresAt: sql`clock_timestamp() + interval '10 minutes'`,
      });
      return;
    case "append_committed":
      await db.insert(corpusIndexProjectionIntents).values({
        ...common,
        status: revision.status,
        appendCommittedAt: sql`clock_timestamp()`,
        appendPublishBarrierAt: sql`clock_timestamp() + ${revision.barrierInMs} * interval '1 millisecond'`,
        expectedDocumentCount: 1,
      });
      return;
    default:
      revision satisfies never;
      panic(`Unhandled unproven revision: ${String(revision)}`);
  }
};

/** An engine that publishes each accepted request at once, as a waited one is. */
const waitedEngine = () => {
  const published = new Map<string, number>();
  let requests = 0;
  return {
    published,
    requests: () => requests,
    client: {
      ingestCommittedBatch: async ({
        ndjson,
      }: {
        ndjson: string;
      }): Promise<Result<void, CorpusIndexError>> => {
        requests += 1;
        for (const line of ndjson.split("\n")) {
          const { projection_revision: revision } = JSON.parse(line);
          if (typeof revision !== "string") {
            return panic("Projection document has no revision");
          }
          published.set(revision, (published.get(revision) ?? 0) + 1);
        }
        return Result.ok(undefined);
      },
      ingestQueuedBatch: async () =>
        panic("Projection append must wait for publication"),
      aggregate: async ({ query }: { query: string }) =>
        Result.ok({
          projection_revisions: {
            buckets: Array.from(published, ([key, count]) => ({
              key,
              doc_count: count,
            })).filter(({ key }) => query.includes(`"${key}"`)),
            doc_count_error_upper_bound: 0,
            sum_other_doc_count: 0,
          },
        }),
    },
  };
};

type CycleOptions = {
  engine: ReturnType<typeof waitedEngine>;
  entityIds: readonly string[];
  unprovenBytesBudget: number;
  /** Runs before each payload read, between reservation and start. */
  beforeRead?: () => Promise<void>;
};

const runCycle = async ({
  engine,
  entityIds,
  unprovenBytesBudget,
  beforeRead = async () => {},
}: CycleOptions) => {
  let reads = 0;
  const result = await executeCorpusProjectionAppendCycle({
    runInTransaction: async (operation) =>
      await db.transaction(
        async (tx) => await operation(asTestRaw<Transaction>(tx)),
      ),
    client: engine.client,
    commitMode: CORPUS_PROJECTION_APPEND_COMMIT_MODE.published,
    ...TARGET,
    scope: {
      type: "subjects",
      entityIds: entityIds.map((id) => toSafeId<"legislationDocument">(id)),
    },
    limit: entityIds.length,
    fillWindowMs: 60_000,
    payloadReadConcurrency: 1,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
    unprovenBytesBudget,
    proofAfterIndexId: null,
    payloadReader: async () => {
      reads += 1;
      await beforeRead();
      return Result.ok(PAYLOAD);
    },
  });
  return { result, reads };
};

const intentsOf = async (entityIds: readonly string[]) =>
  await db
    .select({
      entityId: corpusIndexProjectionIntents.entityId,
      status: corpusIndexProjectionIntents.status,
      appendBytes: corpusIndexProjectionIntents.appendBytes,
      lastError: corpusIndexProjectionIntents.lastError,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.entityId, [...entityIds]));

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "building",
  });
  await db.insert(legislationSources).values({
    id: SOURCE_ID,
    adapterKey: "projection-unproven-budget-test",
    name: "Projection unproven budget test",
    descriptor: null,
  });
});

afterAll(async () => {
  await client.close();
});

// Every seeded entity projects into one index, so each test starts with none
// of its appends unproven.
beforeEach(async () => {
  await db
    .delete(corpusIndexProjectionIntents)
    .where(
      inArray(corpusIndexProjectionIntents.status, [
        ...CORPUS_INDEX_UNPROVEN_APPEND_INTENT_STATUSES,
      ]),
    );
});

describe("the unproven-byte budget", () => {
  test("is validated where the caller supplies it", () => {
    expect(validateCorpusProjectionUnprovenBytesBudget(BUDGET)).toBe(BUDGET);
    for (const invalid of [
      BUDGET - 1,
      CORPUS_PROJECTION_UNPROVEN_BYTES_BUDGET_MAX + 1,
      BUDGET + 0.5,
      Number.NaN,
    ]) {
      expect(() =>
        validateCorpusProjectionUnprovenBytesBudget(invalid),
      ).toThrow("unproven-byte budget must be an integer");
    }
  });

  test("under requests that wait for publication, a budget of one full request holds no chain back and every revision records its bytes", async () => {
    const entityIds = await seedEntities(3);
    const engine = waitedEngine();
    const { result } = await runCycle({
      engine,
      entityIds,
      unprovenBytesBudget: BUDGET,
    });
    expect(result).toMatchObject({
      status: "completed",
      reserved: 3,
      applied: 3,
      cycleRetryDelayMs: null,
    });
    const intents = await intentsOf(entityIds);
    expect(intents.map(({ status }) => status)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
    for (const { appendBytes } of intents) {
      expect(appendBytes).toBeGreaterThan(PAYLOAD.text.length);
    }
  });

  test("an index at the budget reserves nothing, reads no payload, and retries once its earliest accepted revision can be proven", async () => {
    const entityIds = await seedEntities(2);
    const occupied = nth(entityIds, 0);
    const waiting = nth(entityIds, 1);
    const barrierInMs = 60_000;
    await insertUnprovenRevision(occupied, {
      status: "append_committed",
      appendBytes: BUDGET,
      revisionCount: 1,
      barrierInMs,
    });
    const engine = waitedEngine();
    const held = await runCycle({
      engine,
      entityIds: [waiting],
      unprovenBytesBudget: BUDGET,
    });
    expect(held.result).toMatchObject({
      status: "backpressured",
      reserved: 0,
    });
    expect(held.reads).toBe(0);
    expect(held.result.cycleRetryDelayMs).toBeGreaterThan(
      barrierInMs - CLOCK_SLACK_MS,
    );
    expect(held.result.cycleRetryDelayMs).toBeLessThanOrEqual(barrierInMs);
    expect(await intentsOf([waiting])).toEqual([]);

    // One byte more and the same index is below the budget.
    const admitted = await runCycle({
      engine,
      entityIds: [waiting],
      unprovenBytesBudget: BUDGET + 1,
    });
    expect(admitted.result).toMatchObject({ status: "completed", applied: 1 });
  });

  test("a started revision counts until its request has certainly ended", async () => {
    const entityIds = await seedEntities(2);
    const occupied = nth(entityIds, 0);
    const waiting = nth(entityIds, 1);
    await insertUnprovenRevision(occupied, {
      status: "append_started",
      appendBytes: BUDGET,
      revisionCount: 1,
    });
    const { result } = await runCycle({
      engine: waitedEngine(),
      entityIds: [waiting],
      unprovenBytesBudget: BUDGET,
    });
    expect(result.status).toBe("backpressured");
    expect(result.cycleRetryDelayMs).toBeGreaterThan(
      INGEST_BUDGET_MS - CLOCK_SLACK_MS,
    );
    expect(result.cycleRetryDelayMs).toBeLessThanOrEqual(INGEST_BUDGET_MS);
  });

  test("a request that meets the budget at its start is not sent, and its chain is handed back for a later cycle", async () => {
    const entityIds = await seedEntities(3);
    const concurrent = nth(entityIds, 0);
    const first = nth(entityIds, 1);
    const second = nth(entityIds, 2);
    const engine = waitedEngine();
    let raced = false;
    // Another chain starts a full request between this cycle's reservation
    // and its start.
    const held = await runCycle({
      engine,
      entityIds: [first, second],
      unprovenBytesBudget: BUDGET,
      beforeRead: async () => {
        if (!raced) {
          raced = true;
          await insertUnprovenRevision(concurrent, {
            status: "append_started",
            appendBytes: BUDGET,
            revisionCount: 1,
          });
        }
      },
    });
    expect(held.result).toMatchObject({
      status: "backpressured",
      reserved: 2,
      cancelled: 2,
      requestCount: 0,
    });
    expect(held.result.cycleRetryDelayMs).toBeGreaterThan(
      INGEST_BUDGET_MS - CLOCK_SLACK_MS,
    );
    expect(engine.requests()).toBe(0);
    expect(await intentsOf([first, second])).toEqual(
      [first, second].map(() => ({
        entityId: expect.any(String),
        status: "cancelled",
        appendBytes: null,
        lastError:
          "projection append deferred: the index's unproven appends reached the byte budget",
      })),
    );

    // Once the other chain's request has left the budget, the same entities
    // are reserved again and applied.
    await db
      .delete(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.entityId, concurrent));
    const resumed = await runCycle({
      engine,
      entityIds: [first, second],
      unprovenBytesBudget: BUDGET,
    });
    expect(resumed.result).toMatchObject({ status: "completed", applied: 2 });
  });

  test("rows the previous release started record no bytes and count at the most their request could carry", async () => {
    const entityIds = await seedEntities(4);
    const shared = nth(entityIds, 0);
    const sharedMate = nth(entityIds, 1);
    const alone = nth(entityIds, 2);
    const recorded = nth(entityIds, 3);
    // Two revisions that shared a request of three: each was one part of a
    // request no larger than the request cap.
    for (const entityId of [shared, sharedMate]) {
      await insertUnprovenRevision(entityId, {
        status: "append_started",
        appendBytes: null,
        revisionCount: 3,
      });
    }
    // A revision sent alone may have gone in parts up to the revision ceiling.
    await insertUnprovenRevision(alone, {
      status: "append_committed",
      appendBytes: null,
      revisionCount: 1,
      barrierInMs: 60_000,
    });
    await insertUnprovenRevision(recorded, {
      status: "append_committed",
      appendBytes: 1234,
      revisionCount: 5,
      barrierInMs: 60_000,
    });
    const indexId = (await stateOf(shared)).desiredIndexId ?? panic("No index");
    const read = await db.transaction(
      async (tx) =>
        await readBackpressuredCorpusProjectionIndexesTx(
          asTestRaw<Transaction>(tx),
          {
            manifest: MANIFEST,
            indexIds: [indexId],
            unprovenBytesBudget: BUDGET,
          },
        ),
    );
    expect(
      read.map(({ indexId: id, unprovenBytes }) => ({ id, unprovenBytes })),
    ).toEqual([
      {
        id: indexId,
        unprovenBytes:
          2 * CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES +
          CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES +
          1234,
      },
    ]);
  });
});
