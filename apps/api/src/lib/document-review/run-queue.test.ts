/**
 * A `queued` review run whose job never reached the queue has nothing left to
 * drive it, and the row cannot tell that apart from a run still waiting its
 * turn. What is asserted here is the part no type can hold: that such a run is
 * handed back exactly once, that a run the queue still owns is left alone, and
 * that a terminal run is never resurrected. Driven against a real (PGlite)
 * database with a stubbed queue.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import { documentReviewRuns } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import {
  DOCUMENT_REVIEW_RUN_EXECUTOR,
  PLAYBOOK_PIN_PROVENANCE,
} from "@/api/lib/document-review/run-contract";
import { reconcileQueuedDocumentReviewRuns } from "@/api/lib/document-review/run-queue";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();

type StubJobState = "active" | "completed" | "failed" | "waiting";

type AddedJob = { data: unknown; jobId: string; name: string };

const added: AddedJob[] = [];
const priorJobs = new Map<string, StubJobState>();
const removedJobIds: string[] = [];
const retriedJobIds: string[] = [];

const queue = {
  add: async (name: string, data: unknown, options: { jobId: string }) => {
    added.push({ data, jobId: options.jobId, name });
    priorJobs.set(options.jobId, "waiting");
  },
  getJob: async (jobId: string) => {
    const state = priorJobs.get(jobId);
    if (state === undefined) {
      return undefined;
    }
    return {
      getState: async () => state,
      remove: async () => {
        priorJobs.delete(jobId);
        removedJobIds.push(jobId);
      },
      retry: async () => {
        retriedJobIds.push(jobId);
      },
    };
  },
};

const BASIS: DocumentReviewRunBasis = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: PLAYBOOK_PIN_PROVENANCE.EPHEMERAL,
    definitionSnapshot: {
      name: "Reconciler fixture",
      positions: { version: 3, items: [] },
    },
  },
  references: [],
  perspective: NEUTRAL_PERSPECTIVE,
};

const seededRunIds: SafeId<"documentReviewRun">[] = [];

type SeedRunOptions = {
  createdAt?: Date;
  executor?: (typeof DOCUMENT_REVIEW_RUN_EXECUTOR)[keyof typeof DOCUMENT_REVIEW_RUN_EXECUTOR];
  requestedBy?: string | null;
  status?: "queued" | "running" | "completed" | "failed" | "cancelled";
};

/** One run per call, on its own file field: at most one run per document may
 *  be active, so sharing a field would collide instead of seeding. */
const runValues = ({
  createdAt = new Date(),
  executor = DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
  requestedBy = ids.userA1,
  status = "queued",
}: SeedRunOptions = {}) => {
  const runId = createSafeId<"documentReviewRun">();
  seededRunIds.push(runId);
  return {
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    fileFieldId: createSafeId<"field">(),
    entityVersionId: ids.entityVersionA1,
    contentSha256: "a".repeat(64),
    basis: BASIS,
    createdAt,
    executor,
    requestedBy,
    status,
  };
};

const seedRun = async (
  options: SeedRunOptions = {},
): Promise<SafeId<"documentReviewRun">> => {
  const values = runValues(options);
  await testDb.insert(documentReviewRuns).values(values);
  return values.id;
};

const jobIdFor = (runId: SafeId<"documentReviewRun">) =>
  createBullMqJobId(ids.wsA1, runId);

describe("queued document review run reconciliation", () => {
  beforeEach(() => {
    added.length = 0;
    removedJobIds.length = 0;
    retriedJobIds.length = 0;
    priorJobs.clear();
  });

  afterEach(async () => {
    if (seededRunIds.length > 0) {
      await testDb
        .delete(documentReviewRuns)
        .where(inArray(documentReviewRuns.id, seededRunIds));
    }
    seededRunIds.length = 0;
  });

  afterAll(async () => {
    await releaseRlsFixture();
  });

  test("hands a run no job owns back to the queue exactly once", async () => {
    const runId = await seedRun();

    const first = await reconcileQueuedDocumentReviewRuns({
      db: testDb,
      queue,
    });
    const second = await reconcileQueuedDocumentReviewRuns({
      db: testDb,
      queue,
    });

    expect(first).toEqual({ handedOff: 1, scanned: 1, unattributed: 0 });
    // The row is still `queued` — only the worker's claim moves it — so the
    // second sweep sees it again and must recognise its own job.
    expect(second).toEqual({ handedOff: 0, scanned: 1, unattributed: 0 });
    expect(added).toEqual([
      {
        data: {
          contractVersion: 2,
          organizationId: ids.orgA,
          runId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        },
        jobId: jobIdFor(runId),
        name: "run-document-review",
      },
    ]);
  });

  test("leaves finished runs and table-executed runs alone", async () => {
    await seedRun({ status: "completed" });
    await seedRun({ status: "failed" });
    await seedRun({ status: "cancelled" });
    await seedRun({ status: "running" });
    await seedRun({ executor: DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE });

    const result = await reconcileQueuedDocumentReviewRuns({
      db: testDb,
      queue,
    });

    expect(result).toEqual({ handedOff: 0, scanned: 0, unattributed: 0 });
    expect(added).toEqual([]);
  });

  test("reclaims a retained terminal record instead of adding under its id", async () => {
    const completedJobRun = await seedRun();
    const failedJobRun = await seedRun();
    priorJobs.set(jobIdFor(completedJobRun), "completed");
    priorJobs.set(jobIdFor(failedJobRun), "failed");

    const result = await reconcileQueuedDocumentReviewRuns({
      db: testDb,
      queue,
    });

    expect(result.handedOff).toBe(2);
    expect(removedJobIds).toEqual([jobIdFor(completedJobRun)]);
    expect(retriedJobIds).toEqual([jobIdFor(failedJobRun)]);
    expect(added.map(({ jobId }) => jobId)).toEqual([
      jobIdFor(completedJobRun),
    ]);
  });

  test("counts a run whose requester is gone instead of dropping it", async () => {
    await seedRun({ requestedBy: null });

    const result = await reconcileQueuedDocumentReviewRuns({
      db: testDb,
      queue,
    });

    expect(result).toEqual({ handedOff: 0, scanned: 1, unattributed: 1 });
    expect(added).toEqual([]);
  });

  test("pages past a full page of queue-owned runs to reach an orphan", async () => {
    // One page is 100 rows, and a run the queue owns keeps its `queued` row,
    // so a sweep bounded by the first page would never inspect row 101.
    const base = Date.now() - 60 * 60 * 1000;
    const owned = Array.from({ length: 150 }, (_, index) =>
      runValues({ createdAt: new Date(base + index) }),
    );
    await testDb.insert(documentReviewRuns).values(owned);
    for (const { id } of owned) {
      priorJobs.set(jobIdFor(id), "waiting");
    }
    const orphan = await seedRun({ createdAt: new Date(base + 1000) });

    const result = await reconcileQueuedDocumentReviewRuns({
      db: testDb,
      queue,
    });

    expect(result).toEqual({ handedOff: 1, scanned: 151, unattributed: 0 });
    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(orphan)]);
  });

  test("stops at the per-tick handoff limit on a page of orphans", async () => {
    // A full page of rows that all need handing back. Whether a row hands off
    // is only known once its handler returns, so capacity has to be taken
    // before each handler starts or the whole page would be enqueued at once.
    const base = Date.now() - 60 * 60 * 1000;
    const orphans = Array.from({ length: 100 }, (_, index) =>
      runValues({ createdAt: new Date(base + index) }),
    );
    await testDb.insert(documentReviewRuns).values(orphans);

    const result = await reconcileQueuedDocumentReviewRuns({
      db: testDb,
      queue,
    });

    expect(result).toEqual({ handedOff: 50, scanned: 50, unattributed: 0 });
    expect(added).toHaveLength(50);
  });

  test("gives up on a queue command that never answers", async () => {
    // A broker that accepts the connection and then stops replying settles no
    // command on its own. Unbounded, one such row would hold the sweep until
    // its scheduler lease expired and nothing would be recorded at all.
    const runId = await seedRun();
    const analytics = installRecordingAnalytics();
    const stalled = {
      add: async () => undefined,
      getJob: async () =>
        await new Promise<undefined>(() => {
          // Never settles: a broker that accepts the connection and answers
          // nothing leaves the command pending for the life of the process.
        }),
    };

    const result = await reconcileQueuedDocumentReviewRuns({
      db: testDb,
      queue: stalled,
    });
    analytics.restore();

    expect(result).toEqual({ handedOff: 0, scanned: 1, unattributed: 0 });
    // The stall is reported as one captured failure against the row, not lost
    // as a tick that ran out of lease with nothing to show.
    expect(
      analytics
        .exceptions()
        .map(({ properties: { $exception_type, ...context } }) => [
          $exception_type,
          context["runId"],
        ]),
    ).toEqual([["TimeoutError", runId]]);
  });
});
