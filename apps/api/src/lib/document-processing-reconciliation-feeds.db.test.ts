import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  documentProcessingRuns,
  entityVersions,
  extractedContent,
  fields,
  workspaces,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import type {
  DOCUMENT_PROCESSING_RECONCILIATION_PHASE_FEEDS as Feeds,
  DOCUMENT_PROCESSING_RECONCILIATION_PHASES as Phases,
  runDocumentProcessingReconciliationPhases as RunPhases,
} from "@/api/lib/document-processing-queue";
import type * as RedisClientModule from "@/api/lib/redis-client";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * The reconciliation phase order is only correct if the edge map it is
 * ordered against describes what the phases really do. That map is a
 * reading of each phase's writes against every phase's selection
 * predicate, which is exactly the kind of mirror that drifts.
 *
 * This drives the real phases against a database: seed one phase's input,
 * run it, record the rows it wrote, then run another phase and see whether
 * it takes any of them. The observed edges must equal the declared ones,
 * and the order the worker runs must place every producer ahead of every
 * phase it feeds.
 */

const SETTLED_BEFORE_MS = 10 * 60 * 1000;
const STALE_LEASE_MS = 60 * 60 * 1000;
const EXTRACTABLE_FILE = {
  encrypted: false,
  fileName: "scan.pdf",
  id: "",
  mimeType: "application/pdf",
  pdfFileId: null,
  sha256Hex: "c".repeat(64),
  sizeBytes: 64,
  type: "file" as const,
  version: 1 as const,
};

let testDb: TestDatabase;
let ids: TestIds;
/** Flipped by the outage test; the repair phase is the only phase that asks. */
let redisAvailable = true;
let phases: typeof Phases;
let feeds: typeof Feeds;
let runPhases: typeof RunPhases;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  void mock.module("@/api/db/root", () => ({ rootDb: testDb, rlsDb: testDb }));
  // Reconciliation reaches Redis for the repair cursor, BullMQ for the
  // handoff, the search provider for a replay, and realtime for the
  // broadcast. None of them decide which rows a phase selects, which is
  // all this test observes.
  // Each mock declares its module's whole surface, including the exports
  // this test never reaches, so a module that grows one does not quietly
  // lose it here. Spreading the real module instead would import it, and
  // these are the modules being kept out of the process.
  void mock.module(
    "@/api/lib/redis-client",
    () =>
      ({
        connectWithColdStartRetries: async (connect: () => Promise<void>) =>
          await connect(),
        createBullMqConnection: () => ({}),
        createLazyRedisClient: () => ({
          close: () => undefined,
          ready: async () => {
            if (!redisAvailable) {
              throw new Error("redis unavailable");
            }
            return await Promise.resolve({
              get: async () => null,
              send: async () => 1,
            });
          },
        }),
        createRedisClient: () => ({
          close: () => undefined,
          connect: async () => undefined,
          get: async () => null,
          send: async () => 1,
        }),
        isRecoverableRedisPollError: () => false,
        isTransientRedisConnectionError: () => false,
      }) satisfies Record<keyof typeof RedisClientModule, unknown>,
  );
  void mock.module("@/api/lib/document-processing-enqueue", () => ({
    countPendingDocumentProcessingJobs: async () => 0,
    DOCUMENT_PROCESSING_OCR_JOB_NAME: "ocr",
    DOCUMENT_PROCESSING_QUEUE_NAME: "document-processing",
    enqueueDocumentProcessingRun: async () => undefined,
  }));
  void mock.module("@/api/lib/search/provider", () => ({
    getSearchProvider: () => ({ indexEntity: async () => undefined }),
  }));
  void mock.module("@/api/lib/resource-realtime", () => ({
    broadcastOrganizationResourceSetUpdated: () => undefined,
    broadcastWorkspaceResourceChanges: () => undefined,
    broadcastWorkspaceResourceDeleted: () => undefined,
    broadcastWorkspaceResourceSetUpdated: () => undefined,
    broadcastWorkspaceResourceUpdated: () => undefined,
  }));
  ({
    DOCUMENT_PROCESSING_RECONCILIATION_PHASES: phases,
    DOCUMENT_PROCESSING_RECONCILIATION_PHASE_FEEDS: feeds,
    runDocumentProcessingReconciliationPhases: runPhases,
  } = await import("@/api/lib/document-processing-queue"));
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

const insertRun = async (
  run: Partial<typeof documentProcessingRuns.$inferInsert>,
) =>
  await testDb.insert(documentProcessingRuns).values({
    entityId: ids.entityA1,
    entityVersionId: ids.entityVersionA1,
    fieldId: ids.fileFieldA1,
    id: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
    kind: "ocr",
    organizationId: ids.orgA,
    processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
    requestedBy: null,
    requestSource: "upload",
    sourceFileId: ids.fileObjectA1,
    sourceSha256Hex: EXTRACTABLE_FILE.sha256Hex,
    workspaceId: ids.wsA1,
    ...run,
  });

const past = (ms: number) => new Date(Date.now() - ms);

/**
 * Every transition a phase can make, as the state its input must be in
 * for the phase to make it. One fixture per transition, so a declared edge
 * that nothing produces shows up as an unobserved edge.
 */
const FIXTURES = [
  {
    label: "repair inserts a run for an unprocessed file field",
    producer: "repair",
    seed: async () => {
      // No projection: the insert is a queued run rather than a failed
      // search-index one.
      await testDb
        .delete(extractedContent)
        .where(eq(extractedContent.entityId, ids.entityA1));
    },
  },
  {
    label: "repair inserts a search-index failure where a projection exists",
    producer: "repair",
    seed: async () => undefined,
  },
  {
    label: "retry requeues a retryable automatic failure",
    producer: "retry",
    seed: async () => {
      await insertRun({
        attemptCount: 1,
        errorCode: "processing_failed",
        nextAttemptAt: past(1000),
        status: "failed",
      });
    },
  },
  {
    label: "stale-lease requeues an expired lease",
    producer: "stale-lease",
    seed: async () => {
      await insertRun({
        attemptCount: 1,
        claimedAt: past(STALE_LEASE_MS),
        claimedBy: "worker-gone",
        status: "running",
      });
    },
  },
  {
    label: "stale-lease returns an expired search-index replay to failed",
    producer: "stale-lease",
    seed: async () => {
      await insertRun({
        attemptCount: 1,
        claimedAt: past(STALE_LEASE_MS),
        claimedBy: "worker-gone",
        errorCode: "search_index_failed",
        status: "running",
      });
    },
  },
  {
    label: "reindex replays a failed search index",
    producer: "reindex",
    seed: async () => {
      await insertRun({
        attemptCount: 0,
        errorCode: "search_index_failed",
        nextAttemptAt: null,
        status: "failed",
      });
    },
  },
  {
    label: "delivery hands a scheduled run to the queue",
    producer: "delivery",
    seed: async () => {
      await insertRun({ nextAttemptAt: past(1000), status: "queued" });
    },
  },
] as const;

const resetFixtureState = async () => {
  redisAvailable = true;
  await testDb
    .delete(documentProcessingRuns)
    .where(eq(documentProcessingRuns.organizationId, ids.orgA));
  await testDb
    .delete(extractedContent)
    .where(eq(extractedContent.entityId, ids.entityA1));
  await testDb.insert(extractedContent).values({
    charCount: 17,
    ciphertext: Buffer.from("extracted text a1"),
    entityId: ids.entityA1,
    iv: Buffer.alloc(12, 0xa1),
    language: "en",
    organizationId: ids.orgA,
    sourceEntityVersionId: ids.entityVersionA1,
    sourceFieldId: ids.fileFieldA1,
    sourceFileId: ids.fileObjectA1,
    sourceSha256Hex: EXTRACTABLE_FILE.sha256Hex,
    workspaceId: ids.wsA1,
  });
  // The repair sweep only scans settled versions of active workspaces, and
  // only fields whose content it can extract without a PDF derivative.
  await testDb
    .update(workspaces)
    .set({ status: "active" })
    .where(eq(workspaces.id, ids.wsA1));
  await testDb
    .update(entityVersions)
    .set({ createdAt: past(SETTLED_BEFORE_MS) })
    .where(eq(entityVersions.id, ids.entityVersionA1));
  await testDb
    .update(fields)
    .set({
      content: { ...EXTRACTABLE_FILE, id: ids.fileObjectA1 },
    })
    .where(eq(fields.id, ids.fileFieldA1));
};

beforeEach(resetFixtureState);

const snapshotRuns = async () =>
  new Map(
    (
      await testDb
        .select()
        .from(documentProcessingRuns)
        .where(eq(documentProcessingRuns.organizationId, ids.orgA))
    ).map((run) => [run.id, JSON.stringify(run)]),
  );

const changedSince = (
  before: Map<string, string>,
  after: Map<string, string>,
) =>
  new Set(
    [...after.entries()]
      .filter(([id, row]) => before.get(id) !== row)
      .map(([id]) => id),
  );

const runPhase = async (name: string) => {
  const phase = phases.find((candidate) => candidate.name === name);
  if (!phase) {
    throw new Error(`unknown phase ${name}`);
  }
  return await phase.run();
};

type ObservedPair = {
  producedRows: number;
  takesProducedRows: boolean;
};

/**
 * Seed one phase's input, run it, then run another phase and see whether
 * it takes any row the first one wrote.
 */
const observePair = async ({
  consumer,
  producer,
  seed,
}: {
  consumer: string;
  producer: string;
  seed: () => Promise<unknown>;
}): Promise<ObservedPair> => {
  await resetFixtureState();
  await seed();
  const before = await snapshotRuns();
  await runPhase(producer);
  const afterProducer = await snapshotRuns();
  const producedRows = changedSince(before, afterProducer);
  await runPhase(consumer);
  const taken = changedSince(afterProducer, await snapshotRuns());
  return {
    producedRows: producedRows.size,
    takesProducedRows: [...taken].some((id) => producedRows.has(id)),
  };
};

test("the declared phase edges are the edges the phases actually produce", async () => {
  const observed = new Set<string>();
  const produced = new Set<string>();
  const phaseNames = phases.map(({ name }) => name);

  const pairs = FIXTURES.flatMap((fixture) =>
    phaseNames
      .filter((name) => name !== fixture.producer)
      .map((consumer) => ({ consumer, fixture })),
  );
  for (const { consumer, fixture } of pairs) {
    // oxlint-disable-next-line no-await-in-loop -- every pair needs the database to itself
    const pair = await observePair({
      consumer,
      producer: fixture.producer,
      seed: fixture.seed,
    });
    if (pair.producedRows > 0) {
      produced.add(fixture.producer);
    }
    if (pair.takesProducedRows) {
      observed.add(`${fixture.producer} -> ${consumer}`);
    }
  }

  // Every fixture has to make its phase write something, or the edges it
  // is meant to exercise would be trivially absent.
  expect([...produced].toSorted()).toEqual(phaseNames.toSorted());

  const declared = Object.entries(feeds).flatMap(([phase, consumers]) =>
    consumers.map((consumer) => `${phase} -> ${consumer}`),
  );
  expect([...observed].toSorted()).toEqual(declared.toSorted());

  const order = phases.map(({ name }): string => name);
  for (const edge of observed) {
    const [producer, consumer] = edge.split(" -> ");
    expect(order.indexOf(consumer ?? "")).toBeGreaterThan(
      order.indexOf(producer ?? ""),
    );
  }
}, 120_000);

test("a Redis outage fails only the phase that needs Redis", async () => {
  await resetFixtureState();
  // Work for two phases that never touch Redis: one retryable failure and
  // one expired lease.
  await insertRun({
    attemptCount: 1,
    errorCode: "processing_failed",
    nextAttemptAt: past(1000),
    status: "failed",
  });
  await insertRun({
    attemptCount: 1,
    claimedAt: past(STALE_LEASE_MS),
    claimedBy: "worker-gone",
    sourceSha256Hex: "e".repeat(64),
    status: "running",
  });
  const failedPhases: string[] = [];
  redisAvailable = false;

  const results = await runPhases({
    onPhaseError: (_error, phase) => {
      failedPhases.push(phase);
    },
    phases,
  });

  // The repair sweep reads its cursor from Redis and can do nothing
  // without it; every other phase works from the database alone and has to
  // run regardless, which is what the tick would lose if the connection
  // were taken before the phases rather than by the phase that needs it.
  expect(failedPhases).toEqual(["repair"]);
  expect(results.repair).toEqual({ count: 0, hasMore: true });
  expect(results.retry.count).toBe(1);
  expect(results["stale-lease"].count).toBeGreaterThan(0);
}, 120_000);
