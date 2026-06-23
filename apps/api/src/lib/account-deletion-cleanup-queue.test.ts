import { Result, type Result as BetterResult } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId, type SafeId } from "@/api/lib/branded-types";

type RequestStatus = "pending" | "processing" | "completed" | "failed";

type RequestRow = {
  id: SafeId<"accountDeletionRequest">;
  status: RequestStatus;
  storageCleanup: { s3Keys: string[] };
  attemptCount: number;
  errorMessage: string | null;
  completedAt: Date | null;
  updatedAt: Date;
};

type UpdateValues = {
  attemptCount?: unknown;
  completedAt?: Date;
  errorMessage?: string | null;
  status?: unknown;
  updatedAt?: Date;
};

const requestId = toSafeId<"accountDeletionRequest">(
  "00000000-0000-0000-0000-000000000001",
);
let requestRow: RequestRow | null = null;
let updateSets: UpdateValues[] = [];

const deleteS3KeysMock = mock(
  async (_keys: string[]): Promise<BetterResult<void, Error>> => Result.ok(),
);

const isRequestStatus = (value: unknown): value is RequestStatus =>
  value === "pending" ||
  value === "processing" ||
  value === "completed" ||
  value === "failed";

const applyUpdate = (values: UpdateValues) => {
  updateSets.push(values);
  if (!requestRow) {
    return;
  }

  if (isRequestStatus(values.status)) {
    requestRow.status = values.status;
  }
  if ("errorMessage" in values) {
    requestRow.errorMessage = values.errorMessage ?? null;
  }
  if (values.completedAt) {
    requestRow.completedAt = values.completedAt;
  }
  if (values.updatedAt) {
    requestRow.updatedAt = values.updatedAt;
  }
  if (values.attemptCount) {
    requestRow.attemptCount += 1;
  }
};

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
      where: async () => {
        applyUpdate(values);
      },
    }),
  })),
};

void mock.module("@/api/db/root", () => ({
  rootDb: rootDbMock,
}));

void mock.module("@/api/handlers/files/utils", () => ({
  deleteS3Keys: deleteS3KeysMock,
}));

void mock.module("@/api/lib/analytics", () => ({
  captureError: mock(() => {}),
}));

void mock.module("@/api/lib/observability/logger", () => ({
  logger: {
    error: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
  },
}));

const { processAccountDeletionCleanupRequest } =
  await import("./account-deletion-cleanup-queue");

const createRequestRow = (overrides: Partial<RequestRow> = {}): RequestRow => ({
  id: requestId,
  status: "pending",
  storageCleanup: { s3Keys: ["user/file-a", "user/file-b"] },
  attemptCount: 0,
  errorMessage: null,
  completedAt: null,
  updatedAt: new Date("2026-06-23T07:00:00.000Z"),
  ...overrides,
});

describe("account deletion cleanup queue", () => {
  beforeEach(() => {
    requestRow = createRequestRow();
    updateSets = [];
    deleteS3KeysMock.mockReset();
    deleteS3KeysMock.mockImplementation(async () => Result.ok());
  });

  test("deletes S3 keys and marks the request completed", async () => {
    await processAccountDeletionCleanupRequest(requestId);

    expect(deleteS3KeysMock).toHaveBeenCalledWith([
      "user/file-a",
      "user/file-b",
    ]);
    expect(updateSets.map((values) => values.status)).toEqual([
      "processing",
      "completed",
    ]);
    expect(requestRow?.status).toBe("completed");
    expect(requestRow?.completedAt).toBeInstanceOf(Date);
  });

  test("marks the request failed and rethrows when S3 deletion fails", async () => {
    deleteS3KeysMock.mockImplementation(async () =>
      Result.err(new Error("s3 unavailable")),
    );

    let thrown: unknown;
    try {
      await processAccountDeletionCleanupRequest(requestId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("Expected cleanup to throw an Error");
    }
    expect(thrown.message).toBe("s3 unavailable");

    expect(updateSets.map((values) => values.status)).toEqual([
      "processing",
      "failed",
    ]);
    expect(requestRow?.status).toBe("failed");
    expect(requestRow?.errorMessage).toBe("s3 unavailable");
  });

  test("skips completed requests", async () => {
    requestRow = createRequestRow({ status: "completed" });

    await processAccountDeletionCleanupRequest(requestId);

    expect(deleteS3KeysMock).not.toHaveBeenCalled();
    expect(updateSets).toEqual([]);
  });
});
