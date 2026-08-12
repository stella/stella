import { Result, type Result as BetterResult } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { ENTITY_DELETION_EFFECT_KIND } from "@/api/lib/entity-deletion-effect-store";
import type { EntityDeletionEffectClaim } from "@/api/lib/entity-deletion-effect-store";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type RequestStatus = "pending" | "processing" | "completed" | "failed";

const requestId = toSafeId<"entityDeletionCleanupRequest">(
  "00000000-0000-0000-0000-000000000001",
);
const claim: EntityDeletionEffectClaim = asTestRaw({
  attemptCount: 1,
  chunkId: toSafeId<"entityDeletionEffectChunk">(
    "00000000-0000-0000-0000-000000000002",
  ),
  lease: {
    kind: ENTITY_DELETION_EFFECT_KIND,
    token: toSafeId<"effectLease">("00000000-0000-0000-0000-000000000003"),
  },
  requestId,
  s3Keys: ["org/workspace/file.pdf"],
});

const deleteS3KeysMock = mock(
  async (_keys: string[]): Promise<BetterResult<void, Error>> => Result.ok(),
);

const claimChunk = mock(async () => claim as EntityDeletionEffectClaim | null);
const completeChunk = mock(async () => true);
const ensureChunks = mock(async () => 0);
const failChunk = mock(async () => true);

const {
  createEntityDeletionCleanupReconciler,
  deliverEntityDeletionCleanupCandidates,
  enqueueEntityDeletionCleanupJob,
  getEntityDeletionCleanupRetryAt,
  processEntityDeletionCleanupRequest,
} = await import("./entity-deletion-cleanup-queue");
const queueSource = await Bun.file(
  new URL("entity-deletion-cleanup-queue.ts", import.meta.url),
).text();

const cleanupDeps = asTestRaw<
  NonNullable<Parameters<typeof processEntityDeletionCleanupRequest>[1]>
>({
  claimChunk,
  completeChunk,
  deleteS3Keys: deleteS3KeysMock,
  ensureChunks,
  failChunk,
  storageDeleteTimeoutMs: 1000,
});

describe("entity deletion cleanup queue", () => {
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

  test("records a failed cleanup attempt for durable recovery", async () => {
    deleteS3KeysMock.mockImplementationOnce(async () =>
      Result.err(new Error("storage unavailable")),
    );

    const rejection: unknown = await processEntityDeletionCleanupRequest(
      requestId,
      cleanupDeps,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({ message: "storage unavailable" });
    expect(deleteS3KeysMock).toHaveBeenCalledTimes(1);
    expect(failChunk).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ message: "storage unavailable" }),
    );
    expect(completeChunk).not.toHaveBeenCalled();
  });

  test("retires storage keys only after cleanup completes", async () => {
    await processEntityDeletionCleanupRequest(requestId, cleanupDeps);

    expect(deleteS3KeysMock).toHaveBeenCalledWith(["org/workspace/file.pdf"]);
    expect(completeChunk).toHaveBeenCalledWith(claim);
    expect(failChunk).not.toHaveBeenCalled();
  });

  test("times out a stalled storage deletion and schedules durable recovery", async () => {
    deleteS3KeysMock.mockImplementationOnce(async () => {
      const neverSettles = new Promise<void>(() => {});
      await neverSettles;
      return Result.ok();
    });

    const rejection: unknown = await processEntityDeletionCleanupRequest(
      requestId,
      { ...cleanupDeps, storageDeleteTimeoutMs: 5 },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(TimeoutError);
    expect(rejection).toMatchObject({
      label: "entity-deletion-cleanup.storage-delete",
      timeoutMs: 5,
    });
    expect(failChunk).toHaveBeenCalledWith(claim, rejection);
  });

  test("replaces a completed queue job for nonterminal durable cleanup", async () => {
    const add = mock(async () => undefined);
    const remove = mock(async () => undefined);
    const cleanupQueue = asTestRaw<
      Parameters<typeof enqueueEntityDeletionCleanupJob>[0]["cleanupQueue"]
    >({
      add,
      getJob: mock(async () => ({
        getState: mock(async () => "completed"),
        remove,
      })),
    });

    await enqueueEntityDeletionCleanupJob({ cleanupQueue, requestId });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  test("bounds every Redis operation used for deterministic queue delivery", async () => {
    const neverSettles = new Promise<never>(() => {});
    const pending = mock(async () => await neverSettles);
    type CleanupQueue = Parameters<
      typeof enqueueEntityDeletionCleanupJob
    >[0]["cleanupQueue"];
    const queues = [
      asTestRaw<CleanupQueue>({
        add: mock(async () => undefined),
        getJob: pending,
      }),
      asTestRaw<CleanupQueue>({
        add: mock(async () => undefined),
        getJob: mock(async () => ({
          getState: pending,
          remove: mock(async () => undefined),
        })),
      }),
      asTestRaw<CleanupQueue>({
        add: mock(async () => undefined),
        getJob: mock(async () => ({
          getState: mock(async () => "completed" as const),
          remove: pending,
        })),
      }),
      asTestRaw<CleanupQueue>({
        add: pending,
        getJob: mock(async () => undefined),
      }),
    ];

    const errors = await Promise.all(
      queues.map(
        async (queueWithStall) =>
          await enqueueEntityDeletionCleanupJob({
            cleanupQueue: queueWithStall,
            operationTimeoutMs: 5,
            requestId,
          }).then(
            () => null,
            (error: unknown) => error,
          ),
      ),
    );

    expect(errors).toEqual([
      expect.objectContaining({
        label: "entity-deletion-cleanup.queue.get-job",
      }),
      expect.objectContaining({
        label: "entity-deletion-cleanup.queue.get-state",
      }),
      expect.objectContaining({
        label: "entity-deletion-cleanup.queue.remove-job",
      }),
      expect.objectContaining({
        label: "entity-deletion-cleanup.queue.add-job",
      }),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(TimeoutError);
    }
  });

  test("allows only one reconciliation pass at a time", async () => {
    let finishFirstRun: () => void = () => undefined;
    const firstRun = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    let runCount = 0;
    const run = mock(async () => {
      runCount += 1;
      if (runCount === 1) {
        await firstRun;
      }
    });
    const onError = mock((_error: unknown) => undefined);
    const reconcile = createEntityDeletionCleanupReconciler({ onError, run });

    reconcile();
    reconcile();
    expect(run).toHaveBeenCalledTimes(1);

    finishFirstRun();
    await firstRun;
    await Promise.resolve();
    reconcile();

    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  test("attempts every recovery state before surfacing a delivery failure", async () => {
    const enqueueCleanup = mock(
      async (
        _id: SafeId<"entityDeletionCleanupRequest">,
        status?: RequestStatus,
      ) => {
        if (status === "pending") {
          throw new TimeoutError({
            label: "entity-deletion-cleanup.queue.get-job",
            message: "queue timed out",
            timeoutMs: 5,
          });
        }
      },
    );
    const rejection: unknown = await deliverEntityDeletionCleanupCandidates({
      enqueueCleanup,
      failedIds: [requestId],
      pendingIds: [requestId],
      processingIds: [requestId],
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(TimeoutError);
    expect(enqueueCleanup).toHaveBeenCalledTimes(3);
    expect(enqueueCleanup.mock.calls.map((call) => call.at(1))).toEqual([
      "pending",
      "failed",
      "processing",
    ]);
  });

  test("keeps failed cleanup recoverable with capped durable backoff", () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    const firstRetry = getEntityDeletionCleanupRetryAt({
      attemptCount: 1,
      now,
    });
    const eventualRetry = getEntityDeletionCleanupRetryAt({
      attemptCount: 100,
      now,
    });

    expect(firstRetry).toEqual(new Date("2026-07-30T12:01:00.000Z"));
    expect(eventualRetry).toEqual(new Date("2026-07-31T12:00:00.000Z"));
  });

  test("scans each recovery state through its matching bounded schedule", () => {
    expect(queueSource).toContain(
      "listRecoverableEntityDeletionEffectRequestIds",
    );
    expect(queueSource).toContain("enableOfflineQueue: false");
  });
});
