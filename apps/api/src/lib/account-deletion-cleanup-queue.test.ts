import { Result, type Result as BetterResult } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AccountDeletionEffectClaim } from "@/api/lib/account-deletion-effect-store";
import { ACCOUNT_DELETION_EFFECT_KIND } from "@/api/lib/account-deletion-effect-store";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const requestId = toSafeId<"accountDeletionRequest">(
  "00000000-0000-0000-0000-000000000001",
);
const claim: AccountDeletionEffectClaim = asTestRaw({
  attemptCount: 1,
  chunkId: toSafeId<"accountDeletionEffectChunk">(
    "00000000-0000-0000-0000-000000000002",
  ),
  lease: {
    kind: ACCOUNT_DELETION_EFFECT_KIND,
    token: toSafeId<"effectLease">("00000000-0000-0000-0000-000000000003"),
  },
  requestId,
  s3Keys: ["user/file-a", "user/file-b"],
});

const claimChunk = mock(async () => claim as AccountDeletionEffectClaim | null);
const completeChunk = mock(async () => true);
const deleteS3KeysMock = mock(
  async (_keys: string[]): Promise<BetterResult<void, Error>> => Result.ok(),
);
const ensureChunks = mock(async () => 0);
const failChunk = mock(async () => true);

const {
  enqueueAccountDeletionCleanupJob,
  processAccountDeletionCleanupRequest,
} = await import("./account-deletion-cleanup-queue");

const cleanupDeps = asTestRaw<
  NonNullable<Parameters<typeof processAccountDeletionCleanupRequest>[1]>
>({
  claimChunk,
  completeChunk,
  deleteS3Keys: deleteS3KeysMock,
  ensureChunks,
  failChunk,
});

describe("account deletion cleanup queue", () => {
  beforeEach(() => {
    claimChunk.mockReset();
    claimChunk.mockImplementationOnce(async () => claim);
    claimChunk.mockImplementation(async () => null);
    completeChunk.mockReset();
    completeChunk.mockImplementation(async () => true);
    deleteS3KeysMock.mockReset();
    deleteS3KeysMock.mockImplementation(async () => Result.ok());
    ensureChunks.mockReset();
    ensureChunks.mockImplementation(async () => 0);
    failChunk.mockReset();
    failChunk.mockImplementation(async () => true);
  });

  test("deletes one bounded effect and settles its lease", async () => {
    await processAccountDeletionCleanupRequest(requestId, cleanupDeps);

    expect(ensureChunks).toHaveBeenCalledWith(requestId);
    expect(deleteS3KeysMock).toHaveBeenCalledWith([
      "user/file-a",
      "user/file-b",
    ]);
    expect(completeChunk).toHaveBeenCalledWith(claim);
    expect(failChunk).not.toHaveBeenCalled();
  });

  test("durably fails the owned effect before rethrowing", async () => {
    deleteS3KeysMock.mockImplementation(async () =>
      Result.err(new Error("s3 unavailable")),
    );

    const rejection: unknown = await processAccountDeletionCleanupRequest(
      requestId,
      cleanupDeps,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({ message: "s3 unavailable" });
    expect(failChunk).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ message: "s3 unavailable" }),
    );
    expect(completeChunk).not.toHaveBeenCalled();
  });

  test("stops when no eligible chunk can be claimed", async () => {
    claimChunk.mockReset();
    claimChunk.mockImplementation(async () => null);

    await processAccountDeletionCleanupRequest(requestId, cleanupDeps);

    expect(deleteS3KeysMock).not.toHaveBeenCalled();
    expect(completeChunk).not.toHaveBeenCalled();
  });

  test("replaces a retained terminal job before re-enqueueing cleanup", async () => {
    await Promise.all(
      (["failed", "completed"] as const).map(async (state) => {
        const remove = mock(async () => undefined);
        const add = mock(async () => undefined);
        const cleanupQueue = asTestRaw<
          Parameters<typeof enqueueAccountDeletionCleanupJob>[0]["cleanupQueue"]
        >({
          add,
          getJob: mock(async () => ({
            getState: mock(async () => state),
            remove,
          })),
        });

        await enqueueAccountDeletionCleanupJob({ cleanupQueue, requestId });

        expect(remove).toHaveBeenCalledTimes(1);
        expect(add).toHaveBeenCalledTimes(1);
      }),
    );
  });
});
