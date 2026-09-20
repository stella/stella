import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { FILE_COMPARISON_SWEEP_LIMIT } from "@/api/lib/uploads/file-comparison/sweep";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const sweepMock = mock(async () => 0);
const { createSweepFileComparisonUploadsTask } =
  await import("@/api/lib/scheduler/tasks/file-comparison-sweep");

test("schedules one bounded global sweep of expired comparison staging", async () => {
  sweepMock.mockResolvedValue(3);
  const info = mock();
  const signal = new AbortController().signal;

  await createSweepFileComparisonUploadsTask({
    rootSafeDb: asTestRaw<SafeDb>(async () => Result.ok(undefined)),
    sweep: sweepMock,
  })(asTestRaw<SchedulerTaskContext>({ logger: { info }, signal }));

  expect(sweepMock).toHaveBeenCalledWith({
    limit: FILE_COMPARISON_SWEEP_LIMIT,
    safeDb: expect.any(Function),
    signal,
  });
  expect(info).toHaveBeenCalledWith("scheduler.file_comparison_uploads_swept", {
    "fileComparisonUploads.swept": 3,
  });
});
