import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  enqueueDocumentDeadlineScoutJob,
  type DocumentDeadlineScoutJobData,
} from "@/api/lib/document-processing-enqueue";

const JOB: DocumentDeadlineScoutJobData = {
  sourceRunId: toSafeId<"documentProcessingRun">("processing-run"),
};

const existingJob = (state: "active" | "completed" | "delayed" | "failed") => ({
  getState: async () => state,
  remove: mock(async () => undefined),
  retry: mock(async () => undefined),
});

describe("enqueueDocumentDeadlineScoutJob", () => {
  test("adds one deterministic job when none exists", async () => {
    const add = mock(
      async (
        _name: string,
        _job: DocumentDeadlineScoutJobData,
        _options: { jobId: string },
      ) => null,
    );
    const getJob = mock(async () => undefined);

    await enqueueDocumentDeadlineScoutJob({
      scoutQueue: { add, getJob },
      job: JOB,
    });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.at(0)?.at(1)).toEqual(JOB);
    expect(add.mock.calls.at(0)?.at(2)).toEqual({
      jobId: "document%2Ddeadline%2Dscouts-processing%2Drun",
    });
  });

  test.each(["active", "delayed"] as const)(
    "keeps an existing %s job",
    async (state) => {
      const add = mock(async () => undefined);
      const existing = existingJob(state);
      const getJob = mock(async () => existing);

      await enqueueDocumentDeadlineScoutJob({
        scoutQueue: { add, getJob },
        job: JOB,
      });

      expect(add).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
      expect(existing.retry).not.toHaveBeenCalled();
    },
  );

  test("replaces completed queue history while PostgreSQL remains pending", async () => {
    const add = mock(async () => undefined);
    const existing = existingJob("completed");
    const getJob = mock(async () => existing);

    await enqueueDocumentDeadlineScoutJob({
      scoutQueue: { add, getJob },
      job: JOB,
    });

    expect(existing.remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  test("retries the deterministic job after queue exhaustion", async () => {
    const add = mock(async () => undefined);
    const existing = existingJob("failed");
    const getJob = mock(async () => existing);

    await enqueueDocumentDeadlineScoutJob({
      scoutQueue: { add, getJob },
      job: JOB,
    });

    expect(add).not.toHaveBeenCalled();
    expect(existing.retry).toHaveBeenCalledTimes(1);
  });
});
