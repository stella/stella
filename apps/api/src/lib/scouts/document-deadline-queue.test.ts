import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  enqueueDocumentDeadlineScoutJob,
  type DocumentDeadlineScoutJobData,
} from "@/api/lib/document-processing-enqueue";

const JOB: DocumentDeadlineScoutJobData = {
  sourceRunId: toSafeId<"documentProcessingRun">("processing-run"),
  entityId: toSafeId<"entity">("entity"),
  workspaceId: toSafeId<"workspace">("workspace"),
  organizationId: toSafeId<"organization">("organization"),
  requestedBy: toSafeId<"user">("user"),
};

describe("enqueueDocumentDeadlineScoutJob", () => {
  test("adds one deterministic job when none exists", async () => {
    const add = mock(async () => undefined);
    const getJob = mock(async () => undefined);

    await enqueueDocumentDeadlineScoutJob({
      scoutQueue: { add, getJob },
      job: JOB,
    });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.at(0)?.at(1)).toEqual(JOB);
  });

  test("keeps an existing active or completed job", async () => {
    const add = mock(async () => undefined);
    const retry = mock(async () => undefined);
    const getJob = mock(async () => ({
      getState: async () => "completed",
      retry,
    }));

    await enqueueDocumentDeadlineScoutJob({
      scoutQueue: { add, getJob },
      job: JOB,
    });

    expect(add).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  test("retries the deterministic job after queue exhaustion", async () => {
    const add = mock(async () => undefined);
    const retry = mock(async () => undefined);
    const getJob = mock(async () => ({
      getState: async () => "failed",
      retry,
    }));

    await enqueueDocumentDeadlineScoutJob({
      scoutQueue: { add, getJob },
      job: JOB,
    });

    expect(add).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
