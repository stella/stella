import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  fileComparisonUploads,
  schedulerJobs,
  schedulerJobRuns,
  systemAuditRuns,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { OrganizationFileUsageError } from "@/api/lib/files/organization-file-usage";
import { runJob } from "@/api/lib/scheduler/runner";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import {
  FILE_COMPARISON_SWEEP_LIMIT,
  FileComparisonSweepError,
  sweepExpiredFileComparisonUploads,
} from "@/api/lib/uploads/file-comparison/sweep";
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

const sweepMock = mock(async () =>
  Result.ok({ scanned: 0, sweptUploads: 0, failed: 0 }),
);
const {
  createSweepFileComparisonUploadsTask,
  SWEEP_FILE_COMPARISON_UPLOADS_TASK,
} = await import("@/api/lib/scheduler/tasks/file-comparison-sweep");

const recordingDb = (cause?: Error) => {
  const rows: unknown[] = [];
  const tables: unknown[] = [];
  const db = asTestRaw<SchedulerDb>({
    insert: (table: unknown) => {
      tables.push(table);
      return {
        values: async (row: unknown) => {
          if (cause) {
            throw cause;
          }
          rows.push(row);
        },
      };
    },
  });
  return { db, rows, tables };
};

const RUN_ID = "0192f1d2-0000-7000-8000-000000000001";

test("schedules one bounded global sweep of expired comparison staging", async () => {
  sweepMock.mockResolvedValue(
    Result.ok({ scanned: 3, sweptUploads: 3, failed: 0 }),
  );
  const info = mock();
  const signal = new AbortController().signal;
  const { db, rows, tables } = recordingDb();

  await createSweepFileComparisonUploadsTask({
    rootSafeDb: asTestRaw<SafeDb>(async () => Result.ok(undefined)),
    sweep: sweepMock,
  })(
    asTestRaw<SchedulerTaskContext>({
      db,
      logger: { info },
      runId: RUN_ID,
      signal,
    }),
  );

  expect(sweepMock).toHaveBeenCalledWith({
    limit: FILE_COMPARISON_SWEEP_LIMIT,
    safeDb: expect.any(Function),
    signal,
  });
  expect(info).toHaveBeenCalledWith("scheduler.file_comparison_uploads_swept", {
    "fileComparisonUploads.swept": 3,
    "fileComparisonUploads.scanned": 3,
    "fileComparisonUploads.failed": 0,
  });
  expect(tables).toEqual([systemAuditRuns]);
  expect(rows).toEqual([
    {
      id: expect.any(String),
      actor: "system:file-comparison-sweep",
      subject: RUN_ID,
      counts: { sweptUploads: 3 },
    },
  ]);
});

test("a sweep that removed nothing records no audit run", async () => {
  sweepMock.mockResolvedValue(
    Result.ok({ scanned: 0, sweptUploads: 0, failed: 0 }),
  );
  const { db, rows } = recordingDb();

  await createSweepFileComparisonUploadsTask({
    rootSafeDb: asTestRaw<SafeDb>(async () => Result.ok(undefined)),
    sweep: sweepMock,
  })(
    asTestRaw<SchedulerTaskContext>({
      db,
      logger: { info: mock() },
      runId: RUN_ID,
      signal: new AbortController().signal,
    }),
  );

  expect(rows).toEqual([]);
});

test.each(["healthy", "partial"] as const)(
  "%s sweep propagates audit failure without replacing the first cause",
  async (mode) => {
    const auditCause = new TypeError("Audit insert failed");
    const sweepCause = new FileComparisonSweepError({
      message: "Object deletion failed",
      cause: new TypeError("Object failed"),
      summary: { scanned: 2, sweptUploads: 1, failed: 1 },
    });
    const { db } = recordingDb(auditCause);
    const warn = mock();
    const outcome = await createSweepFileComparisonUploadsTask({
      sweep: async () =>
        mode === "partial"
          ? Result.err(sweepCause)
          : Result.ok({ scanned: 1, sweptUploads: 1, failed: 0 }),
    })(
      asTestRaw<SchedulerTaskContext>({
        db,
        logger: { info: mock(), warn },
        runId: RUN_ID,
        signal: new AbortController().signal,
      }),
    );
    if (!outcome || Result.isOk(outcome)) {
      throw new Error("Expected task failure");
    }
    expect(outcome.error.cause).toBe(
      mode === "partial" ? sweepCause : auditCause,
    );
    expect(warn).toHaveBeenCalledTimes(mode === "partial" ? 1 : 0);
  },
);

const { testDb, ids } = await getRlsFixture();
const JOB_ID = "test.comparisonSweep.reporting";
const uploadIds = Array.from({ length: 3 }, () =>
  createSafeId<"fileComparisonUpload">(),
);
const safeDb: SafeDb = async (run) =>
  await Result.tryPromise(
    async () =>
      await testDb.transaction(
        async (tx) => await run(asTestRaw<Transaction>(tx)),
      ),
  );

const runInRunner = async (
  task: ReturnType<typeof createSweepFileComparisonUploadsTask>,
) => {
  const job = await testDb.query.schedulerJobs.findFirst({
    where: { id: { eq: JOB_ID } },
  });
  if (!job) {
    panic("Expected comparison sweep job");
  }
  return await runJob({
    db: asTestRaw<SchedulerDb>(testDb),
    heartbeatIntervalMs: 60_000,
    job,
    leaseMs: 120_000,
    maxRuntimeMs: 30_000,
    registry: new Map([[SWEEP_FILE_COMPARISON_UPLOADS_TASK, task]]),
    runnerId: "test-comparison-sweep-runner",
    signal: undefined,
  });
};

const remainingIds = async () =>
  (
    await testDb
      .select({ id: fileComparisonUploads.id })
      .from(fileComparisonUploads)
      .where(inArray(fileComparisonUploads.id, uploadIds))
      .orderBy(fileComparisonUploads.id)
  ).map(({ id }) => id);

describe("comparison sweep replay and runner capture", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;
  beforeEach(async () => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
    await testDb.insert(fileComparisonUploads).values(
      uploadIds.map((id) => ({
        id,
        organizationId: ids.orgA,
        userId: ids.userA1,
        kind: "input" as const,
        declaredName: "Draft.docx",
        declaredSize: 1,
        declaredSha256: "a".repeat(64),
        expiresAt: new Date(Date.now() - 60_000),
      })),
    );
    await testDb
      .insert(schedulerJobs)
      .values({
        id: JOB_ID,
        task: SWEEP_FILE_COMPARISON_UPLOADS_TASK,
        schedule: { type: "interval", everyMs: 300_000 },
        nextRunAt: new Date(),
        lockedBy: "test-lease",
        payload: { cursor: null },
      })
      .onConflictDoUpdate({
        target: schedulerJobs.id,
        set: { lockedBy: "test-lease" },
      });
  });
  afterEach(async () => {
    analytics.restore();
    logs.restore();
    await testDb
      .delete(fileComparisonUploads)
      .where(inArray(fileComparisonUploads.id, uploadIds));
    await testDb
      .delete(schedulerJobRuns)
      .where(eq(schedulerJobRuns.jobId, JOB_ID));
    await testDb
      .delete(systemAuditRuns)
      .where(eq(systemAuditRuns.actor, "system:file-comparison-sweep"));
  });
  afterAll(async () => {
    await testDb.delete(schedulerJobs).where(eq(schedulerJobs.id, JOB_ID));
    await releaseRlsFixture();
  });

  test.each(
    ["read", "remove", "objects", "ledger"].flatMap((stage) => [
      {
        stage,
        grade: "defect",
        reason: "unclassified",
        cause: new TypeError("Sweep dependency failed"),
      },
      {
        stage,
        grade: "transient",
        reason: "network_reset",
        cause: Object.assign(new Error("Connection reset"), {
          code: "ECONNRESET",
        }),
      },
    ]),
  )(
    "$stage: one $grade capture, retained rows and replay",
    async ({ stage, cause, grade, reason }) => {
      let calls = 0;
      const rootSafeDb: SafeDb = async (run) => {
        calls += 1;
        if (
          (stage === "read" && calls === 1) ||
          (stage === "remove" && calls === 2)
        ) {
          return await Result.tryPromise(async () => {
            throw cause;
          });
        }
        return await safeDb(run);
      };
      const failedIds = [uploadIds[0], uploadIds[2]];
      const task = createSweepFileComparisonUploadsTask({
        rootSafeDb,
        sweep: async (options) =>
          await sweepExpiredFileComparisonUploads({
            ...options,
            deleteObject: async (key) => {
              if (
                (stage === "objects" || stage === "ledger") &&
                failedIds.some((id) => key.endsWith(id))
              ) {
                if (stage === "ledger") {
                  return Result.err(
                    new OrganizationFileUsageError({
                      message: "Ledger unavailable",
                      reason: "storage_unavailable",
                      cause,
                    }),
                  );
                }
                throw cause;
              }
              return Result.ok(undefined);
            },
          }),
      });
      expect(await runInRunner(task)).toBe("failed");
      expect(analytics.exceptions()).toHaveLength(1);
      expect(analytics.exceptions().at(0)?.properties).toMatchObject({
        "error.class": "FileComparisonSweepError",
        "failure.grade": grade,
        "failure.reason": reason,
      });
      expect(
        logs.records.filter(
          ({ message }) => message === "scheduler.job_failed",
        ),
      ).toHaveLength(1);
      const rowWarnings = logs.records.filter(
        ({ message, attributes }) =>
          message === "file_comparison.sweep_delete_failed" &&
          attributes?.["sweep.stage"] === "object",
      );
      expect(rowWarnings).toHaveLength(
        stage === "objects" || stage === "ledger" ? 2 : 0,
      );
      expect(
        rowWarnings.every(({ severityText }) => severityText === "WARN"),
      ).toBe(true);
      const retained =
        stage === "objects" || stage === "ledger" ? failedIds : uploadIds;
      expect(await remainingIds()).toEqual(retained.toSorted());
      expect(
        await testDb
          .select({ status: schedulerJobRuns.status })
          .from(schedulerJobRuns)
          .where(eq(schedulerJobRuns.jobId, JOB_ID)),
      ).toEqual([{ status: "failed" }]);
      const replay = await sweepExpiredFileComparisonUploads({
        safeDb,
        deleteObject: async () => Result.ok(undefined),
      });
      expect(replay).toEqual(
        Result.ok({
          scanned: retained.length,
          sweptUploads: retained.length,
          failed: 0,
        }),
      );
      expect(await remainingIds()).toEqual([]);
      expect(
        await sweepExpiredFileComparisonUploads({
          safeDb,
          deleteObject: async () => Result.ok(undefined),
        }),
      ).toEqual(Result.ok({ scanned: 0, sweptUploads: 0, failed: 0 }));
      expect(analytics.exceptions()).toHaveLength(1);
    },
  );

  test("counts only rows still expired at the removal fence", async () => {
    const renewedId = uploadIds[0];
    const outcome = await sweepExpiredFileComparisonUploads({
      safeDb,
      deleteObject: async (key) => {
        if (key.endsWith(renewedId)) {
          await testDb
            .update(fileComparisonUploads)
            .set({ expiresAt: new Date(Date.now() + 60_000) })
            .where(eq(fileComparisonUploads.id, renewedId));
        }
        return Result.ok(undefined);
      },
    });
    expect(outcome).toEqual(
      Result.ok({ scanned: 3, sweptUploads: 2, failed: 0 }),
    );
    expect(await remainingIds()).toEqual([renewedId]);
    expect(analytics.exceptions()).toHaveLength(0);
  });
});
