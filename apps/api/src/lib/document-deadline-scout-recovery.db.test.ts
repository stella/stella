/**
 * A run whose deadline scout is `pending` has work owed to a queue, and
 * nothing on the row says whether a job is already carrying it. What is
 * asserted here is that the sweep dispatches such a run, and that repeating
 * the sweep does not enqueue it a second time — the property the scheduler
 * depends on now that it drives this beside the document processing worker.
 * Driven against a real (PGlite) database with a stubbed queue.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { documentProcessingRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { enqueueDocumentDeadlineScoutJob } from "@/api/lib/document-processing-enqueue";
import type { DocumentDeadlineScoutJobData } from "@/api/lib/document-processing-enqueue";
import { recoverDocumentDeadlineScoutDispatches } from "@/api/lib/document-processing-queue";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

const added: { data: DocumentDeadlineScoutJobData; jobId: string }[] = [];
const liveJobIds = new Set<string>();

/** The real handoff over a stubbed queue, so the idempotency under test is
 *  the one production runs rather than a re-implementation. */
const scoutQueue = {
  add: async (
    _name: string,
    data: DocumentDeadlineScoutJobData,
    options: { jobId: string },
  ) => {
    added.push({ data, jobId: options.jobId });
    liveJobIds.add(options.jobId);
  },
  getJob: async (jobId: string) =>
    liveJobIds.has(jobId)
      ? {
          getState: async () => "waiting" as const,
          remove: async () => {
            liveJobIds.delete(jobId);
          },
          retry: async () => undefined,
        }
      : undefined,
};

const sweep = async () =>
  await recoverDocumentDeadlineScoutDispatches({
    database: asTestRaw<typeof rootDb>(testDb),
    enqueueDocumentDeadlineScout: async (job) =>
      await enqueueDocumentDeadlineScoutJob({ scoutQueue, job }),
  });

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

beforeEach(async () => {
  added.length = 0;
  liveJobIds.clear();
  await testDb.delete(documentProcessingRuns);
});

const insertPendingScoutRun = async (): Promise<
  SafeId<"documentProcessingRun">
> => {
  const runId = toSafeId<"documentProcessingRun">(Bun.randomUUIDv7());
  await testDb.insert(documentProcessingRuns).values({
    id: runId,
    entityId: ids.entityA1,
    entityVersionId: ids.entityVersionA1,
    fieldId: ids.fileFieldA1,
    kind: "ocr",
    organizationId: ids.orgA,
    processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
    requestedBy: null,
    requestSource: "upload",
    sourceFileId: ids.fileObjectA1,
    sourceSha256Hex: "c".repeat(64),
    workspaceId: ids.wsA1,
    // A succeeded run is the only state a scout dispatch is owed from.
    status: "succeeded",
    finishedAt: new Date(),
    deadlineScoutStatus: "pending",
  });
  return runId;
};

test("dispatches a pending scout no job owns, and only once", async () => {
  const runId = await insertPendingScoutRun();

  const first = await sweep();
  const second = await sweep();

  expect(first.count).toBe(1);
  expect(second.count).toBe(1);
  // The row stays `pending` until the scout worker claims it, so the second
  // sweep selects it again and must recognise the job it already added.
  expect(added).toEqual([
    { data: { sourceRunId: runId }, jobId: added.at(0)?.jobId ?? "" },
  ]);
});

test("leaves a run whose scout is already settled alone", async () => {
  const runId = await insertPendingScoutRun();
  await testDb
    .update(documentProcessingRuns)
    .set({ deadlineScoutStatus: "succeeded" })
    .where(eq(documentProcessingRuns.id, runId));

  const result = await sweep();

  expect(result.count).toBe(0);
  expect(added).toEqual([]);
});

/** Older than the dispatch lease, so the sweep nominates it as expired. */
const EXPIRED_LEASE_MS = 10 * 60 * 1000;

const insertExpiredScoutClaim = async (): Promise<
  SafeId<"documentProcessingRun">
> => {
  const runId = await insertPendingScoutRun();
  await testDb
    .update(documentProcessingRuns)
    .set({
      deadlineScoutClaimedAt: new Date(Date.now() - EXPIRED_LEASE_MS),
      deadlineScoutStatus: "running",
    })
    .where(eq(documentProcessingRuns.id, runId));
  return runId;
};

/**
 * A database handle that runs `claim` once, immediately before the first
 * UPDATE the sweep issues: the window between selecting an expired dispatch
 * and resetting it, in which the other sweep's reset can let a worker take a
 * fresh claim on the same row.
 */
const databaseClaimingBeforeFirstUpdate = (claim: () => Promise<void>) => {
  let armed = true;
  const deferred = <Chain extends object>(chain: Chain): Chain =>
    new Proxy(chain, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") {
          return value;
        }
        // Awaiting the chain is what runs the statement, so the claim lands
        // between the sweep's select and its update. The real `then` is
        // called afterwards, unwrapped, so the query itself is untouched.
        if (property === "then") {
          return async (...args: unknown[]) => {
            if (armed) {
              armed = false;
              await claim();
            }
            return await Reflect.apply(value, target, args);
          };
        }
        return (...args: unknown[]) => {
          const next: unknown = Reflect.apply(value, target, args);
          return typeof next === "object" && next !== null
            ? deferred(next)
            : next;
        };
      },
    });
  return asTestRaw<typeof rootDb>({
    select: testDb.select.bind(testDb),
    update: (table: Parameters<typeof testDb.update>[0]) =>
      deferred(testDb.update(table)),
  });
};

test("does not reset a claim taken between the select and the update", async () => {
  // The scheduler sweep and the processing worker's own reconciliation loop
  // both select this row as expired. The first resets it, a worker claims a
  // fresh attempt, and an id-only update from the second would push that live
  // claim back to `pending`: the worker's settlement predicate would then
  // reject its own result and the metered scan would replay every sweep.
  const runId = await insertExpiredScoutClaim();
  const freshClaimedAt = new Date();
  const database = databaseClaimingBeforeFirstUpdate(async () => {
    await testDb
      .update(documentProcessingRuns)
      .set({
        deadlineScoutClaimedAt: freshClaimedAt,
        deadlineScoutStatus: "running",
      })
      .where(eq(documentProcessingRuns.id, runId));
  });

  const result = await recoverDocumentDeadlineScoutDispatches({
    database,
    enqueueDocumentDeadlineScout: async (job) =>
      await enqueueDocumentDeadlineScoutJob({ scoutQueue, job }),
  });

  const [row] = await testDb
    .select({
      claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
      status: documentProcessingRuns.deadlineScoutStatus,
    })
    .from(documentProcessingRuns)
    .where(eq(documentProcessingRuns.id, runId));
  expect(row?.status).toBe("running");
  expect(row?.claimedAt?.getTime()).toBe(freshClaimedAt.getTime());
  // Nothing transitioned, so the sweep reports no effect rather than counting
  // a row it did not move.
  expect(result.count).toBe(0);
  expect(added).toEqual([]);
});
