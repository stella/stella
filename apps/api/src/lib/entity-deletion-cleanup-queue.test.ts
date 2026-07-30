import { Result, type Result as BetterResult } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type RequestStatus = "pending" | "processing" | "completed" | "failed";

type RequestRow = {
  attemptCount: number;
  id: SafeId<"entityDeletionCleanupRequest">;
  s3Keys: string[];
  status: RequestStatus;
};

type UpdateValues = { status?: RequestStatus };

const requestId = toSafeId<"entityDeletionCleanupRequest">(
  "00000000-0000-0000-0000-000000000001",
);
let requestRow: RequestRow | null = null;
let statuses: RequestStatus[] = [];

const deleteS3KeysMock = mock(
  async (_keys: string[]): Promise<BetterResult<void, Error>> => Result.ok(),
);

const rootDbMock = {
  select: mock((_selection: unknown) => ({
    from: () => ({
      where: () => ({
        limit: async () => (requestRow ? [requestRow] : []),
      }),
    }),
  })),
  update: mock((_table: unknown) => ({
    set: (values: UpdateValues) => ({
      where: () => {
        if (values.status) {
          if (values.status === "processing" && requestRow) {
            requestRow.attemptCount++;
          }
          statuses.push(values.status);
          if (requestRow) {
            requestRow.status = values.status;
          }
        }
        return {
          returning: async () =>
            requestRow
              ? [
                  {
                    attemptCount: requestRow.attemptCount,
                    s3Keys: requestRow.s3Keys,
                  },
                ]
              : [],
        };
      },
    }),
  })),
};

const {
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
  deleteS3Keys: deleteS3KeysMock,
  logger: { warn: mock(() => {}) },
  rootDb: rootDbMock,
});

describe("entity deletion cleanup queue", () => {
  beforeEach(() => {
    requestRow = {
      attemptCount: 0,
      id: requestId,
      s3Keys: ["org/workspace/file.pdf"],
      status: "pending",
    };
    statuses = [];
    deleteS3KeysMock.mockReset();
    deleteS3KeysMock.mockImplementation(async () => Result.ok());
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
    expect(requestRow?.status).toBe("failed");

    expect(deleteS3KeysMock).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["processing", "failed"]);
    expect(requestRow?.status).toBe("failed");
  });

  test("fences a stale claim from overwriting its successor", () => {
    const claim = queueSource.indexOf(
      "attemptCount: entityDeletionCleanupRequests.attemptCount",
    );
    const finalizationFence =
      "eq(entityDeletionCleanupRequests.attemptCount, claim.attemptCount)";
    const firstFinalization = queueSource.indexOf(finalizationFence, claim);
    const secondFinalization = queueSource.indexOf(
      finalizationFence,
      firstFinalization + finalizationFence.length,
    );

    expect(claim).toBeGreaterThan(-1);
    expect(firstFinalization).toBeGreaterThan(claim);
    expect(secondFinalization).toBeGreaterThan(firstFinalization);
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
    expect(queueSource).not.toContain("MAX_RECONCILED_ATTEMPTS");
    expect(queueSource).toContain(
      'eq(entityDeletionCleanupRequests.status, "pending")',
    );
    expect(queueSource).toContain(
      "lte(entityDeletionCleanupRequests.nextAttemptAt, now)",
    );
    expect(queueSource).toContain(
      "lt(entityDeletionCleanupRequests.updatedAt, staleBefore)",
    );
  });
});
