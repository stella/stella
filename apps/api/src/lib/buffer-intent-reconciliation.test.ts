import { Result } from "better-result";
import { beforeEach, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const s3DeleteMock = mock(async () => undefined);

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({ delete: s3DeleteMock }),
}));

const { reconcileStaleBufferIntentsGlobally } =
  await import("@/api/lib/buffer-intent-reconciliation");

const pendingUploadId = toSafeId<"pendingUpload">(
  "00000000-0000-0000-0000-000000000001",
);
const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000002",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000003",
);

type UpdateValues = {
  claimedAt?: Date | undefined;
  finalizedAt?: Date | undefined;
  status?: string | undefined;
};

const createReconciliationSafeDb = (updates: UpdateValues[]): SafeDb => {
  const row = {
    declaredMime:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    id: pendingUploadId,
    organizationId,
    purpose: "entity_create",
    purposeData: {
      type: "entity_create" as const,
      propertyId: toSafeId<"property">("00000000-0000-0000-0000-000000000004"),
      reservedFileId: "00000000-0000-0000-0000-000000000005",
    },
    workspaceId,
  };
  const tx = asTestRaw<Transaction>({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              for: async () => [row],
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: UpdateValues) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    }),
  });

  return asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) =>
      await Result.tryPromise({
        try: async () => await run(tx),
        catch: (cause) => cause,
      }),
  );
};

beforeEach(() => {
  s3DeleteMock.mockReset();
  s3DeleteMock.mockResolvedValue(undefined);
});

test("keeps a reclaimed writer intent recoverable after deleting its object", async () => {
  const updates: UpdateValues[] = [];

  const claimed = await reconcileStaleBufferIntentsGlobally({
    safeDb: createReconciliationSafeDb(updates),
    limit: 1,
  });

  expect(claimed).toBe(1);
  expect(s3DeleteMock).toHaveBeenCalledTimes(1);
  expect(updates.at(-1)).toEqual(
    expect.objectContaining({
      claimedAt: expect.any(Date),
      status: "failed",
    }),
  );
  expect(updates.at(-1)).not.toHaveProperty("finalizedAt");
});

test("stops an in-flight object cleanup when the scheduler aborts", async () => {
  const updates: UpdateValues[] = [];
  let deletionStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    deletionStarted = resolve;
  });
  s3DeleteMock.mockImplementation(async () => {
    deletionStarted?.();
    return await new Promise<never>(() => {
      // Intentionally pending: only the scheduler abort may settle the batch.
    });
  });
  const controller = new AbortController();
  const reconciliation = reconcileStaleBufferIntentsGlobally({
    safeDb: createReconciliationSafeDb(updates),
    limit: 1,
    signal: controller.signal,
  });

  await started;
  controller.abort();

  const rejection: unknown = await reconciliation.then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toMatchObject({
    message: "The operation was aborted.",
    name: "AbortError",
  });
  expect(updates).toHaveLength(1);
  expect(updates.at(0)).toEqual(
    expect.objectContaining({ status: "scanning" }),
  );
});
