/**
 * A style set that still names a superseded package is owed a deletion. If the
 * job that would run it was lost, nothing else observes that: the object stays
 * in storage and the column it left behind blocks the next replacement. What
 * is asserted here is who may release that column — the job, once the object
 * is actually gone, never the sweep that only enqueued it — and that the sweep
 * pages past packages a live job already covers. Driven against a real
 * (PGlite) database with a stubbed queue and a fake object store.
 */

import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { schedulerJobRuns, schedulerJobs, styleSets } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { runJob } from "@/api/lib/scheduler/runner";
import {
  createReconcileStyleSetPackageCleanupsTask,
  RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK,
} from "@/api/lib/scheduler/tasks/style-set-package-cleanup-reconcile";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import {
  deleteUnreferencedStyleSetPackage,
  reconcilePendingStyleSetPackageCleanups,
  StyleSetPackageCleanupRequeueError,
} from "@/api/lib/style-set-package-cleanup-queue";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();

type StubJobState = "active" | "completed" | "delayed" | "failed";

type AddedJob = {
  data: unknown;
  delay: number | undefined;
  jobId: string;
  name: string;
};

const added: AddedJob[] = [];
const priorJobs = new Map<string, StubJobState>();
const lookupFailures = new Map<string, Error>();
const stateFailures = new Map<string, Error>();
const addFailures = new Map<string, Error>();
const removeFailures = new Map<string, Error>();
const retryFailures = new Map<string, Error>();

const cleanupQueue = {
  add: async (
    name: string,
    data: unknown,
    options: { delay?: number; jobId: string },
  ) => {
    const failure = addFailures.get(options.jobId);
    if (failure !== undefined) {
      throw failure;
    }
    added.push({
      data,
      delay: options.delay,
      jobId: options.jobId,
      name,
    });
    priorJobs.set(options.jobId, "delayed");
  },
  getJob: async (jobId: string) => {
    const failure = lookupFailures.get(jobId);
    if (failure !== undefined) {
      throw failure;
    }
    const state = priorJobs.get(jobId);
    if (state === undefined) {
      return undefined;
    }
    return {
      getState: async () => {
        const stateFailure = stateFailures.get(jobId);
        if (stateFailure !== undefined) {
          throw stateFailure;
        }
        return state;
      },
      remove: async () => {
        const removeFailure = removeFailures.get(jobId);
        if (removeFailure !== undefined) {
          throw removeFailure;
        }
        priorJobs.delete(jobId);
      },
      retry: async () => {
        const retryFailure = retryFailures.get(jobId);
        if (retryFailure !== undefined) {
          throw retryFailure;
        }
        priorJobs.set(jobId, "delayed");
      },
    };
  },
};

const SETTLED_AT = new Date(Date.now() - 60 * 60 * 1000);

const bucket = envBase.S3_BUCKET;
let fake: FakeS3;

/** The packages surviving in the store. */
const storedKeys = (): string[] =>
  [...fake.objects.keys()].map((id) => id.slice(bucket.length + 1));

const seededStyleSetIds: SafeId<"styleSet">[] = [];

type SeedStyleSetOptions = {
  cleanupS3Key?: string | null;
  s3Key?: string;
  updatedAt?: Date;
};

const styleSetValues = ({
  cleanupS3Key = null,
  s3Key,
  updatedAt = SETTLED_AT,
}: SeedStyleSetOptions = {}) => {
  const styleSetId = createSafeId<"styleSet">();
  seededStyleSetIds.push(styleSetId);
  return {
    id: styleSetId,
    organizationId: ids.orgA,
    name: "Reconciler fixture",
    fileName: "styles.docx",
    s3Key: s3Key ?? `style-sets/${styleSetId}/current.docx`,
    cleanupS3Key,
    sizeBytes: 12,
    createdBy: ids.userA1,
    updatedAt,
  };
};

const seedStyleSet = async (
  options: SeedStyleSetOptions = {},
): Promise<SafeId<"styleSet">> => {
  const values = styleSetValues(options);
  await testDb.insert(styleSets).values(values);
  return values.id;
};

/** Panics rather than reporting a missing row as a released marker: the row is
 *  seeded by the test, so its absence is a broken fixture, and reading it as
 *  `null` would let every marker assertion pass without exercising anything. */
const readCleanupKey = async (styleSetId: SafeId<"styleSet">) => {
  const [row] = await testDb
    .select({ cleanupS3Key: styleSets.cleanupS3Key })
    .from(styleSets)
    .where(eq(styleSets.id, styleSetId));
  if (row === undefined) {
    panic(`expected the seeded style set ${styleSetId}`);
  }
  return row.cleanupS3Key;
};

const jobIdFor = (s3Key: string) =>
  createBullMqJobId("delete-style-set-package", s3Key);

const reconcile = async () => {
  const outcome = await reconcilePendingStyleSetPackageCleanups({
    cleanupQueue,
    db: testDb,
  });
  if (Result.isError(outcome)) {
    throw outcome.error;
  }
  return outcome.value;
};

const SCHEDULER_JOB_ID = "test.styleSets.reconcilePackageCleanups";
const task = createReconcileStyleSetPackageCleanupsTask({ cleanupQueue });

const seedSchedulerJob = async () => {
  const [job] = await testDb
    .insert(schedulerJobs)
    .values({
      id: SCHEDULER_JOB_ID,
      task: RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK,
      schedule: { type: "interval", everyMs: 300_000 },
      nextRunAt: new Date(),
      lockedBy: "test-style-set-cleanup-lease",
    })
    .returning();
  return job ?? panic("Expected scheduler job");
};

const runTask = async () => {
  const job = await seedSchedulerJob();
  return await task({
    db: asTestRaw<SchedulerDb>(testDb),
    dueAt: DueSlot.of(job),
    job,
    logger,
    payload: job.payload,
    runId: createSafeId<"schedulerJobRun">(),
    scheduleContinuation: () => undefined,
    signal: new AbortController().signal,
  });
};

describe("pending style set package cleanup reconciliation", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeAll(() => {
    fake = startFakeS3();
  });

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
    added.length = 0;
    priorJobs.clear();
    lookupFailures.clear();
    stateFailures.clear();
    addFailures.clear();
    removeFailures.clear();
    retryFailures.clear();
    fake.objects.clear();
  });

  afterEach(async () => {
    analytics.restore();
    logs.restore();
    await testDb
      .delete(schedulerJobRuns)
      .where(eq(schedulerJobRuns.jobId, SCHEDULER_JOB_ID));
    await testDb
      .delete(schedulerJobs)
      .where(eq(schedulerJobs.id, SCHEDULER_JOB_ID));
    if (seededStyleSetIds.length > 0) {
      await testDb
        .delete(styleSets)
        .where(inArray(styleSets.id, seededStyleSetIds));
    }
    seededStyleSetIds.length = 0;
  });

  afterAll(async () => {
    try {
      fake.stop();
    } finally {
      await releaseRlsFixture();
    }
  });

  test("enqueues an owed deletion and leaves the marker for the job", async () => {
    const cleanupS3Key = "style-sets/owed/superseded.docx";
    const styleSetId = await seedStyleSet({ cleanupS3Key });

    const result = await reconcile();

    expect(result).toEqual({ failed: 0, handedOff: 1, scanned: 1 });
    expect(added).toEqual([
      {
        data: { s3Key: cleanupS3Key, styleSetId },
        // The download URL handed out before the replacement has already
        // expired for a row this old, so the deletion runs immediately.
        delay: 0,
        jobId: jobIdFor(cleanupS3Key),
        name: "delete-style-set-package",
      },
    ]);
    // The job may run before any write here lands, and a marker released
    // ahead of the deletion is the only record of the retry, gone.
    expect(await readCleanupKey(styleSetId)).toBe(cleanupS3Key);
  });

  test("releases the marker once the job has deleted the object", async () => {
    const cleanupS3Key = "style-sets/deleted/superseded.docx";
    const styleSetId = await seedStyleSet({ cleanupS3Key });
    fake.put(bucket, cleanupS3Key, "style set package");

    await deleteUnreferencedStyleSetPackage(cleanupS3Key, testDb);

    expect(storedKeys()).toEqual([]);
    expect(await readCleanupKey(styleSetId)).toBeNull();
  });

  test("leaves the marker for the next sweep when the job skipped", async () => {
    // Something still serves this key, so the deletion is refused. The marker
    // is the durable record that it is still owed and must survive.
    const servedKey = "style-sets/served/live.docx";
    await seedStyleSet({ s3Key: servedKey });
    const owingStyleSetId = await seedStyleSet({ cleanupS3Key: servedKey });
    fake.put(bucket, servedKey, "style set package");

    await deleteUnreferencedStyleSetPackage(servedKey, testDb);

    expect(storedKeys()).toEqual([servedKey]);
    expect(await readCleanupKey(owingStyleSetId)).toBe(servedKey);

    const result = await reconcile();

    expect(result).toEqual({ failed: 0, handedOff: 1, scanned: 1 });
    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(servedKey)]);
  });

  test("leaves rows that owe nothing and rows still inside the handoff window", async () => {
    await seedStyleSet();
    await seedStyleSet({
      cleanupS3Key: "style-sets/fresh/superseded.docx",
      updatedAt: new Date(),
    });

    const result = await reconcile();

    expect(result).toEqual({ failed: 0, handedOff: 0, scanned: 0 });
    expect(added).toEqual([]);
  });

  test("does not spend budget on a deletion a live job already covers", async () => {
    const cleanupS3Key = "style-sets/live/superseded.docx";
    await seedStyleSet({ cleanupS3Key });
    priorJobs.set(jobIdFor(cleanupS3Key), "delayed");

    const result = await reconcile();

    expect(added).toEqual([]);
    expect(result).toEqual({ failed: 0, handedOff: 0, scanned: 1 });
  });

  test("pages past more covered rows than a tick may hand off", async () => {
    // A cleanup waits out the whole download TTL, so a healthy row keeps a
    // live delayed job long after it leaves the settle window. More such rows
    // than the per-tick handoff limit therefore sit ahead of a stranded one on
    // the keyset, and counting them as handoffs would end the tick before it
    // ever reached it.
    const base = SETTLED_AT.getTime();
    const covered = Array.from({ length: 60 }, (_, index) =>
      styleSetValues({
        cleanupS3Key: `style-sets/covered/${index}.docx`,
        updatedAt: new Date(base + index),
      }),
    );
    await testDb.insert(styleSets).values(covered);
    for (const { cleanupS3Key } of covered) {
      priorJobs.set(jobIdFor(cleanupS3Key ?? ""), "delayed");
    }
    const strandedKey = "style-sets/stranded/superseded.docx";
    await seedStyleSet({
      cleanupS3Key: strandedKey,
      updatedAt: new Date(base + 1000),
    });

    const result = await reconcile();

    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(strandedKey)]);
    expect(result).toEqual({ failed: 0, handedOff: 1, scanned: 61 });
  });

  test.each(["lookup", "state", "add", "remove", "retry"] as const)(
    "retains partial work, markers and the first cause after a queue %s failure",
    async (operation) => {
      const failedRows = [];
      for (const suffix of ["first", "second"]) {
        const cleanupS3Key = `style-sets/refused/${suffix}.docx`;
        const styleSetId = await seedStyleSet({ cleanupS3Key });
        const cause = new Error(`Queue ${suffix} refused`);
        failedRows.push({ cleanupS3Key, styleSetId, cause });
        const jobId = jobIdFor(cleanupS3Key);
        switch (operation) {
          case "lookup":
            lookupFailures.set(jobId, cause);
            break;
          case "state":
            priorJobs.set(jobId, "delayed");
            stateFailures.set(jobId, cause);
            break;
          case "add":
            addFailures.set(jobId, cause);
            break;
          case "remove":
            priorJobs.set(jobId, "completed");
            removeFailures.set(jobId, cause);
            break;
          case "retry":
            priorJobs.set(jobId, "failed");
            retryFailures.set(jobId, cause);
            break;
          default:
            operation satisfies never;
        }
      }
      const healthyKey = "style-sets/healthy/superseded.docx";
      const healthyId = await seedStyleSet({ cleanupS3Key: healthyKey });

      const outcome = await reconcilePendingStyleSetPackageCleanups({
        cleanupQueue,
        db: testDb,
      });

      if (!Result.isError(outcome)) {
        panic("Expected partial cleanup requeue failure");
      }
      expect(outcome.error).toBeInstanceOf(StyleSetPackageCleanupRequeueError);
      expect(outcome.error.summary).toEqual({
        failed: 2,
        handedOff: 1,
        scanned: 3,
      });
      expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(healthyKey)]);
      const failures = logs.records.filter(
        ({ message }) => message === "style_set.package_cleanup_requeue_failed",
      );
      expect(failures).toHaveLength(2);
      expect(
        failures.every(({ severityText }) => severityText === "WARN"),
      ).toBe(true);
      const firstReported = failedRows.find(
        ({ styleSetId }) =>
          styleSetId === failures.at(0)?.attributes.styleSetId,
      );
      expect(firstReported).toBeDefined();
      expect(outcome.error.cause).toBe(firstReported?.cause);
      for (const { styleSetId, cleanupS3Key } of failedRows) {
        expect(await readCleanupKey(styleSetId)).toBe(cleanupS3Key);
        expect(
          failures.find(
            ({ attributes }) => attributes.styleSetId === styleSetId,
          )?.attributes,
        ).toEqual({ stage: "requeue", styleSetId });
      }
      expect(await readCleanupKey(healthyId)).toBe(healthyKey);
      expect(analytics.exceptions()).toHaveLength(0);

      lookupFailures.clear();
      stateFailures.clear();
      addFailures.clear();
      removeFailures.clear();
      retryFailures.clear();
      const resumed = await reconcile();
      expect(resumed).toEqual({
        failed: 0,
        handedOff: operation === "state" ? 0 : 2,
        scanned: 3,
      });
      // A live handoff from the partial tick is already owned on the retry.
      expect(
        added.filter(({ jobId }) => jobId === jobIdFor(healthyKey)),
      ).toHaveLength(1);
      for (const { styleSetId, cleanupS3Key } of failedRows) {
        expect(await readCleanupKey(styleSetId)).toBe(cleanupS3Key);
      }
    },
  );

  test("the task propagates two row failures without capturing", async () => {
    const cause = new Error("Queue refused");
    for (const suffix of ["first", "second"]) {
      const cleanupS3Key = `style-sets/task/${suffix}.docx`;
      await seedStyleSet({ cleanupS3Key });
      addFailures.set(jobIdFor(cleanupS3Key), cause);
    }
    const healthyKey = "style-sets/task/healthy.docx";
    await seedStyleSet({ cleanupS3Key: healthyKey });

    const outcome = await runTask();

    if (!outcome || !Result.isError(outcome)) {
      panic("Expected failed cleanup task result");
    }
    expect(outcome.error).toBeInstanceOf(SchedulerTaskFailure);
    expect(outcome.error.cause).toBeInstanceOf(
      StyleSetPackageCleanupRequeueError,
    );
    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(healthyKey)]);
    expect(
      logs.records.find(
        ({ message }) =>
          message === "scheduler.style_set_package_cleanups_reconciled",
      )?.attributes,
    ).toMatchObject({
      "styleSetPackageCleanups.enqueued": 1,
      "styleSetPackageCleanups.failed": 2,
      "styleSetPackageCleanups.scanned": 3,
    });
    expect(analytics.exceptions()).toHaveLength(0);
  });

  test.each(["defect", "transient"] as const)(
    "the real runner records one %s exception and a failed cleanup tick",
    async (grade) => {
      const cause =
        grade === "defect"
          ? new Error("Queue refused")
          : Object.assign(new Error("Redis connection reset"), {
              code: "ECONNRESET",
            });
      for (const suffix of ["first", "second"]) {
        const cleanupS3Key = `style-sets/runner/${suffix}.docx`;
        await seedStyleSet({ cleanupS3Key });
        addFailures.set(jobIdFor(cleanupS3Key), cause);
      }
      const job = await seedSchedulerJob();

      const status = await runJob({
        db: asTestRaw<SchedulerDb>(testDb),
        heartbeatIntervalMs: 60_000,
        job,
        leaseMs: 120_000,
        maxRuntimeMs: 30_000,
        registry: new Map([[RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK, task]]),
        runnerId: "test-style-set-cleanup-runner",
        signal: undefined,
      });

      expect(status).toBe("failed");
      expect(analytics.exceptions()).toHaveLength(1);
      expect(analytics.exceptions().at(0)?.properties).toMatchObject({
        "error.class": "StyleSetPackageCleanupRequeueError",
        "failure.grade": grade,
        "failure.reason": grade === "defect" ? "unclassified" : "network_reset",
      });
      expect(
        logs.records.filter(
          ({ message }) => message === "scheduler.job_failed",
        ),
      ).toHaveLength(1);
      const runs = await testDb
        .select({ status: schedulerJobRuns.status })
        .from(schedulerJobRuns)
        .where(eq(schedulerJobRuns.jobId, SCHEDULER_JOB_ID));
      expect(runs).toEqual([{ status: "failed" }]);
    },
  );

  test("a healthy task returns success without a capture", async () => {
    const cleanupS3Key = "style-sets/task/success.docx";
    await seedStyleSet({ cleanupS3Key });

    const outcome = await runTask();

    expect(outcome && !Result.isError(outcome)).toBe(true);
    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(cleanupS3Key)]);
    expect(
      logs.records.find(
        ({ message }) =>
          message === "scheduler.style_set_package_cleanups_reconciled",
      )?.attributes,
    ).toMatchObject({
      "styleSetPackageCleanups.enqueued": 1,
      "styleSetPackageCleanups.failed": 0,
      "styleSetPackageCleanups.scanned": 1,
    });
    expect(analytics.exceptions()).toHaveLength(0);
  });
});
