import { describe, expect, mock, test } from "bun:test";

import { enqueueStyleSetPackageCleanupJob } from "@/api/lib/style-set-package-cleanup-queue";

describe("style set package cleanup queue", () => {
  test("retains replaced packages for the requested grace period", async () => {
    const add = mock(async () => undefined);
    const getJob = mock(async () => undefined);

    await enqueueStyleSetPackageCleanupJob({
      cleanupQueue: { add, getJob },
      delayMs: 900_000,
      s3Key: "org/style-sets/set/old.docx",
      styleSetId: "set",
    });

    expect(add).toHaveBeenCalledWith(
      "delete-style-set-package",
      { s3Key: "org/style-sets/set/old.docx", styleSetId: "set" },
      {
        delay: 900_000,
        jobId:
          "delete%2Dstyle%2Dset%2Dpackage-org%2Fstyle%2Dsets%2Fset%2Fold.docx",
      },
    );
  });

  test("requeues a cleanup job after its retries were exhausted", async () => {
    const remove = mock(async () => undefined);
    const getJob = mock(async () => ({
      getState: async () => "failed",
      remove,
    }));
    const add = mock(async () => undefined);

    await enqueueStyleSetPackageCleanupJob({
      cleanupQueue: { add, getJob },
      delayMs: -1,
      s3Key: "old.docx",
      styleSetId: "set",
    });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "delete-style-set-package",
      { s3Key: "old.docx", styleSetId: "set" },
      {
        delay: 0,
        jobId: "delete%2Dstyle%2Dset%2Dpackage-old.docx",
      },
    );
  });
  test("reclaims the retained record of a completed no-op claim", async () => {
    // A claim placed ahead of the write runs while the style set is still
    // live, finds its key referenced, and completes doing nothing. That record
    // is retained under the same key-derived job id, so a later replacement
    // would add a duplicate id, BullMQ would drop it, and the superseded
    // object would have no runnable cleanup.
    const remove = mock(async () => undefined);
    const getJob = mock(async () => ({
      getState: async () => "completed",
      remove,
    }));
    const add = mock(async () => undefined);

    await enqueueStyleSetPackageCleanupJob({
      cleanupQueue: { add, getJob },
      delayMs: 900_000,
      s3Key: "old.docx",
      styleSetId: "set",
    });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  test("leaves a claim that has not run yet alone", async () => {
    // A delayed or active job is the claim; re-adding it would either be
    // ignored or reset the grace period the caller is relying on.
    const remove = mock(async () => undefined);
    const getJob = mock(async () => ({
      getState: async () => "delayed",
      remove,
    }));
    const add = mock(async () => undefined);

    await enqueueStyleSetPackageCleanupJob({
      cleanupQueue: { add, getJob },
      delayMs: 900_000,
      s3Key: "old.docx",
      styleSetId: "set",
    });

    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
