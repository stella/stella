import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { systemAuditRuns } from "@/api/db/schema";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { FILE_COMPARISON_SWEEP_LIMIT } from "@/api/lib/uploads/file-comparison/sweep";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const sweepMock = mock(async () => 0);
const { createSweepFileComparisonUploadsTask } =
  await import("@/api/lib/scheduler/tasks/file-comparison-sweep");

const recordingDb = () => {
  const rows: unknown[] = [];
  const tables: unknown[] = [];
  const db = asTestRaw<SchedulerDb>({
    insert: (table: unknown) => {
      tables.push(table);
      return {
        values: async (row: unknown) => {
          rows.push(row);
        },
      };
    },
  });
  return { db, rows, tables };
};

const RUN_ID = "0192f1d2-0000-7000-8000-000000000001";

test("schedules one bounded global sweep of expired comparison staging", async () => {
  sweepMock.mockResolvedValue(3);
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
  sweepMock.mockResolvedValue(0);
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
