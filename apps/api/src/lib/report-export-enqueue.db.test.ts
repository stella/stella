/**
 * A `queued` export whose job never reached the queue has nothing left to
 * drive it, and the row cannot tell that apart from an export still waiting
 * its turn. What is asserted here is the part no type can hold: that such an
 * export is handed back exactly once, carrying the format and narrative flag
 * the request was made with, and that a finished export is never resurrected.
 * Driven against a real (PGlite) database with a stubbed queue.
 */

import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import {
  reportExports,
  schedulerJobRuns,
  schedulerJobs,
} from "@/api/db/schema";
import type { ReportExportFormat, ReportExportStatus } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { logger } from "@/api/lib/observability/logger";
import {
  reconcileQueuedReportExports,
  ReportExportRequeueError,
} from "@/api/lib/report-export-enqueue";
import {
  recoverStuckReportExports,
  ReportExportInspectionError,
} from "@/api/lib/report-export-recovery";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { runJob } from "@/api/lib/scheduler/runner";
import {
  createReconcileReportExportsTask,
  RECONCILE_REPORT_EXPORTS_TASK,
} from "@/api/lib/scheduler/tasks/report-export-reconcile";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { ViewLayout } from "@/api/lib/views-schema";
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

type StubJobState = "active" | "completed" | "failed" | "waiting";

type AddedJob = { data: unknown; jobId: string; name: string };

const added: AddedJob[] = [];
const priorJobs = new Map<string, StubJobState>();
const lookupFailures = new Map<string, Error>();
const stateFailures = new Map<string, Error>();
const addFailures = new Map<string, Error>();

const queue = {
  add: async (name: string, data: unknown, options: { jobId: string }) => {
    const failure = addFailures.get(options.jobId);
    if (failure !== undefined) {
      throw failure;
    }
    added.push({ data, jobId: options.jobId, name });
    priorJobs.set(options.jobId, "waiting");
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
        priorJobs.delete(jobId);
      },
      retry: async () => {
        priorJobs.set(jobId, "waiting");
      },
    };
  },
};

const LAYOUT: ViewLayout = {
  type: "table",
  version: 1,
  calculations: [],
  columnOrder: [],
  columnPinning: [],
  filters: [],
  hiddenProperties: [],
  sorts: [],
};

const seededExportIds: SafeId<"reportExport">[] = [];

type SeedExportOptions = {
  aiNarrative?: boolean | null;
  createdAt?: Date;
  format?: ReportExportFormat | null;
  requestedBy?: string | null;
  status?: ReportExportStatus;
};

const exportValues = ({
  aiNarrative = true,
  createdAt = new Date(),
  format = "docx",
  requestedBy = ids.userA1,
  status = "queued",
}: SeedExportOptions = {}) => {
  const exportId = createSafeId<"reportExport">();
  seededExportIds.push(exportId);
  return {
    id: exportId,
    workspaceId: ids.wsA1,
    requestedBy,
    templateRef: { type: "builtin", key: "due-diligence" } as const,
    layout: LAYOUT,
    mode: "download" as const,
    format,
    aiNarrative,
    status,
    createdAt,
  };
};

const seedExport = async (
  options: SeedExportOptions = {},
): Promise<SafeId<"reportExport">> => {
  const values = exportValues(options);
  await testDb.insert(reportExports).values(values);
  return values.id;
};

const jobIdFor = (exportId: SafeId<"reportExport">) =>
  createBullMqJobId(ids.wsA1, exportId);

const reconcile = async () => {
  const outcome = await reconcileQueuedReportExports({ db: testDb, queue });
  if (Result.isError(outcome)) {
    throw outcome.error;
  }
  return outcome.value;
};

const SCHEDULER_JOB_ID = "test.reportExports.reconcileQueued";
const task = createReconcileReportExportsTask({ queue });

const seedSchedulerJob = async () => {
  const [job] = await testDb
    .insert(schedulerJobs)
    .values({
      id: SCHEDULER_JOB_ID,
      task: RECONCILE_REPORT_EXPORTS_TASK,
      schedule: { type: "interval", everyMs: 300_000 },
      nextRunAt: new Date(),
      lockedBy: "test-report-export-lease",
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

const seedStaleRunningExport = async () => {
  const exportId = await seedExport({ status: "running" });
  await testDb
    .update(reportExports)
    .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
    .where(eq(reportExports.id, exportId));
  return exportId;
};

describe("queued report export reconciliation", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
    added.length = 0;
    priorJobs.clear();
    lookupFailures.clear();
    stateFailures.clear();
    addFailures.clear();
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
    if (seededExportIds.length > 0) {
      await testDb
        .delete(reportExports)
        .where(inArray(reportExports.id, seededExportIds));
    }
    seededExportIds.length = 0;
  });

  afterAll(async () => {
    await releaseRlsFixture();
  });

  test("hands an export no job owns back to the queue exactly once, with the request it was made with", async () => {
    const exportId = await seedExport({ aiNarrative: false, format: "pdf" });

    const first = await reconcile();
    const second = await reconcile();

    expect(first).toEqual({
      failed: 0,
      handedOff: 1,
      scanned: 1,
      unattributed: 0,
      unrecoverable: 0,
    });
    // The row is still `queued` — only the worker's claim moves it — so the
    // second sweep sees it again and must recognise its own job.
    expect(second).toEqual({
      failed: 0,
      handedOff: 0,
      scanned: 1,
      unattributed: 0,
      unrecoverable: 0,
    });
    expect(added).toEqual([
      {
        data: {
          exportId,
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
          format: "pdf",
          aiNarrative: false,
        },
        jobId: jobIdFor(exportId),
        name: "export-report",
      },
    ]);
  });

  test("leaves finished exports alone", async () => {
    await seedExport({ status: "completed" });
    await seedExport({ status: "failed" });
    await seedExport({ status: "running" });

    const result = await reconcile();

    expect(result).toEqual({
      failed: 0,
      handedOff: 0,
      scanned: 0,
      unattributed: 0,
      unrecoverable: 0,
    });
    expect(added).toEqual([]);
  });

  test("counts an export whose requester is gone instead of dropping it", async () => {
    await seedExport({ requestedBy: null });

    const result = await reconcile();

    expect(result).toEqual({
      failed: 0,
      handedOff: 0,
      scanned: 1,
      unattributed: 1,
      unrecoverable: 0,
    });
    expect(added).toEqual([]);
  });

  test("fails a queued export whose request was never recorded", async () => {
    // Rows written before the columns existed carry their format and
    // narrative flag on the job alone. Handing one back would mean inventing
    // options and running a different export than the one asked for.
    const exportId = await seedExport({ aiNarrative: null, format: null });

    const result = await reconcile();

    expect(result).toEqual({
      failed: 0,
      handedOff: 0,
      scanned: 1,
      unattributed: 0,
      unrecoverable: 1,
    });
    expect(added).toEqual([]);
    const [row] = await testDb
      .select({ error: reportExports.error, status: reportExports.status })
      .from(reportExports)
      .where(eq(reportExports.id, exportId));
    // Terminal and legible, so the requester stops polling a row nothing will
    // pick up and knows to run it again.
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("run it again");
  });

  test("pages past a full page of queue-owned exports to reach an orphan", async () => {
    // One page is 100 rows, and an export the queue owns keeps its `queued`
    // row, so a sweep bounded by the first page would never inspect row 101.
    const base = Date.now() - 60 * 60 * 1000;
    const owned = Array.from({ length: 150 }, (_, index) =>
      exportValues({ createdAt: new Date(base + index) }),
    );
    await testDb.insert(reportExports).values(owned);
    for (const { id } of owned) {
      priorJobs.set(jobIdFor(id), "waiting");
    }
    const orphan = await seedExport({ createdAt: new Date(base + 1000) });

    const result = await reconcile();

    expect(result).toEqual({
      failed: 0,
      handedOff: 1,
      scanned: 151,
      unattributed: 0,
      unrecoverable: 0,
    });
    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(orphan)]);
  });

  test("stops at the per-tick handoff limit on a page of orphans", async () => {
    // A full page of exports that all need handing back. Whether a row hands
    // off is only known once its handler returns, so capacity has to be taken
    // before each handler starts or the whole page would be enqueued at once —
    // a queue storm of metered fills rather than a paced drain.
    const base = Date.now() - 60 * 60 * 1000;
    const orphans = Array.from({ length: 100 }, (_, index) =>
      exportValues({ createdAt: new Date(base + index) }),
    );
    await testDb.insert(reportExports).values(orphans);

    const result = await reconcile();

    expect(result).toEqual({
      failed: 0,
      handedOff: 50,
      scanned: 50,
      unattributed: 0,
      unrecoverable: 0,
    });
    expect(added).toHaveLength(50);
  });

  test.each(["lookup", "state", "add"] as const)(
    "returns partial requeue counts on a queue %s failure",
    async (operation) => {
      const first = await seedExport();
      const second = await seedExport();
      const healthy = await seedExport();
      const cause = new Error("Queue operation refused");
      for (const exportId of [first, second]) {
        const jobId = jobIdFor(exportId);
        switch (operation) {
          case "lookup":
            lookupFailures.set(jobId, cause);
            break;
          case "state":
            priorJobs.set(jobId, "waiting");
            stateFailures.set(jobId, cause);
            break;
          case "add":
            addFailures.set(jobId, cause);
            break;
          default:
            operation satisfies never;
        }
      }

      const outcome = await reconcileQueuedReportExports({ db: testDb, queue });

      if (!Result.isError(outcome)) {
        panic("Expected partial requeue failure");
      }
      expect(outcome.error).toBeInstanceOf(ReportExportRequeueError);
      expect(outcome.error.cause).toBe(cause);
      expect(outcome.error.summary).toEqual({
        failed: 2,
        handedOff: 1,
        scanned: 3,
        unattributed: 0,
        unrecoverable: 0,
      });
      expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(healthy)]);
      const failures = logs.records.filter(
        ({ message }) => message === "report_export.requeue_failed",
      );
      expect(failures).toHaveLength(2);
      expect(
        failures.every(({ severityText }) => severityText === "WARN"),
      ).toBe(true);
      expect(analytics.exceptions()).toHaveLength(0);
    },
  );

  test.each(["lookup", "state"] as const)(
    "keeps unknown ownership and partial recovery counts on a queue %s failure",
    async (operation) => {
      const first = await seedStaleRunningExport();
      const second = await seedStaleRunningExport();
      const abandoned = await seedStaleRunningExport();
      const cause = new Error("Queue inspection refused");
      for (const exportId of [first, second]) {
        const jobId = jobIdFor(exportId);
        if (operation === "lookup") {
          lookupFailures.set(jobId, cause);
        } else {
          priorJobs.set(jobId, "active");
          stateFailures.set(jobId, cause);
        }
      }

      const outcome = await recoverStuckReportExports({ db: testDb, queue });

      if (!Result.isError(outcome)) {
        panic("Expected partial inspection failure");
      }
      expect(outcome.error).toBeInstanceOf(ReportExportInspectionError);
      expect(outcome.error.cause).toBe(cause);
      expect(outcome.error.summary).toEqual({ failed: 2, recovered: 1 });
      const rows = await testDb
        .select({ id: reportExports.id, status: reportExports.status })
        .from(reportExports)
        .where(inArray(reportExports.id, [first, second, abandoned]));
      expect(rows.find(({ id }) => id === first)?.status).toBe("running");
      expect(rows.find(({ id }) => id === second)?.status).toBe("running");
      expect(rows.find(({ id }) => id === abandoned)?.status).toBe("failed");
      const failures = logs.records.filter(
        ({ message }) => message === "report_export.inspection_failed",
      );
      expect(failures).toHaveLength(2);
      expect(
        failures.every(({ severityText }) => severityText === "WARN"),
      ).toBe(true);
      expect(analytics.exceptions()).toHaveLength(0);
    },
  );

  const failPhases = async (
    phase: "inspect" | "requeue" | "both",
    cause: Error,
  ) => {
    if (phase !== "requeue") {
      const exportId = await seedStaleRunningExport();
      lookupFailures.set(jobIdFor(exportId), cause);
    }
    if (phase !== "inspect") {
      const exportId = await seedExport();
      addFailures.set(jobIdFor(exportId), cause);
    }
  };

  test.each(["inspect", "requeue", "both"] as const)(
    "propagates %s failures through the task without capturing",
    async (phase) => {
      await failPhases(phase, new Error("Queue refused"));

      const outcome = await runTask();

      if (!outcome || !Result.isError(outcome)) {
        panic("Expected failed task result");
      }
      expect(outcome.error).toBeInstanceOf(SchedulerTaskFailure);
      expect(outcome.error.cause).toBeInstanceOf(
        phase === "requeue"
          ? ReportExportRequeueError
          : ReportExportInspectionError,
      );
      expect(
        logs.records.find(
          ({ message }) => message === "scheduler.report_exports_reconciled",
        )?.attributes,
      ).toMatchObject({ "reportExports.failed": phase === "both" ? 2 : 1 });
      expect(analytics.exceptions()).toHaveLength(0);
    },
  );

  test.each([
    { phase: "inspect", grade: "defect" },
    { phase: "requeue", grade: "defect" },
    { phase: "both", grade: "defect" },
    { phase: "inspect", grade: "transient" },
    { phase: "requeue", grade: "transient" },
    { phase: "both", grade: "transient" },
  ] as const)(
    "records one $grade exception and a failed run for $phase",
    async ({ phase, grade }) => {
      const cause =
        grade === "defect"
          ? new Error("Queue refused")
          : Object.assign(new Error("Redis connection reset"), {
              code: "ECONNRESET",
            });
      await failPhases(phase, cause);
      const job = await seedSchedulerJob();

      const status = await runJob({
        db: asTestRaw<SchedulerDb>(testDb),
        heartbeatIntervalMs: 60_000,
        job,
        leaseMs: 120_000,
        maxRuntimeMs: 30_000,
        registry: new Map([[RECONCILE_REPORT_EXPORTS_TASK, task]]),
        runnerId: "test-report-export-runner",
        signal: undefined,
      });

      expect(status).toBe("failed");
      expect(analytics.exceptions()).toHaveLength(1);
      expect(analytics.exceptions().at(0)?.properties).toMatchObject({
        "error.class":
          phase === "requeue"
            ? "ReportExportRequeueError"
            : "ReportExportInspectionError",
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
    const exportId = await seedExport();

    const outcome = await runTask();

    expect(outcome && !Result.isError(outcome)).toBe(true);
    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(exportId)]);
    expect(
      logs.records.find(
        ({ message }) => message === "scheduler.report_exports_reconciled",
      )?.attributes,
    ).toMatchObject({ "reportExports.failed": 0, "reportExports.requeued": 1 });
    expect(analytics.exceptions()).toHaveLength(0);
  });
});
