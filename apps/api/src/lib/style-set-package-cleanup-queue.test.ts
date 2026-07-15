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
    });

    expect(add).toHaveBeenCalledWith(
      "delete-style-set-package",
      { s3Key: "org/style-sets/set/old.docx" },
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
    });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "delete-style-set-package",
      { s3Key: "old.docx" },
      {
        delay: 0,
        jobId: "delete%2Dstyle%2Dset%2Dpackage-old.docx",
      },
    );
  });
});
