import { Result } from "better-result";
import { beforeEach, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { BUFFER_OBJECT_CLEANUP_INTENT_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const s3DeleteMock = mock(
  async (_key: string, _signal: AbortSignal) => undefined,
);

const {
  BUFFER_INTENT_RECOVERY_RETIRE_AFTER_ATTEMPTS,
  isBufferIntentWorkspaceUnavailableError,
  lockObjectCleanupIntentsForWriter,
  lockActiveWorkspaceForBufferIntent,
  OBJECT_INTENT_WORKSPACE_AVAILABILITY,
  reconcileBufferObjectCleanupIntents,
  reconcileStaleBufferIntentsGlobally,
  releaseObjectCleanupIntentsForLifecycle,
  reserveObjectCleanupIntents,
  settleObjectCleanupIntentsAfterWriterInTransaction,
} = await import("@/api/lib/buffer-intent-reconciliation");

const pendingUploadId = toSafeId<"pendingUpload">(
  "00000000-0000-0000-0000-000000000001",
);
const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000002",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000003",
);
const otherWorkspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000006",
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

test("share-locks an active workspace before reserving a writer intent", async () => {
  const locks: unknown[] = [];
  const tx = asTestRaw<Transaction>({
    select: () => ({
      from: () => ({
        where: () => ({
          for: (strength: unknown) => {
            locks.push(strength);
            return { limit: async () => [{ status: "active" }] };
          },
        }),
      }),
    }),
  });

  await lockActiveWorkspaceForBufferIntent(tx, workspaceId);

  expect(locks).toEqual(["share"]);
});

test("rejects a writer reservation after workspace deletion seals", async () => {
  const tx = asTestRaw<Transaction>({
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({ limit: async () => [{ status: "deleting" }] }),
        }),
      }),
    }),
  });

  const rejection: unknown = await lockActiveWorkspaceForBufferIntent(
    tx,
    workspaceId,
  ).then(
    () => null,
    (error: unknown) => error,
  );

  expect(rejection).toMatchObject({
    _tag: "BufferIntentWorkspaceUnavailableError",
    message: "Workspace is not active",
  });
  expect(isBufferIntentWorkspaceUnavailableError(rejection)).toBeTrue();
});

test("reserves multi-workspace ownership under one ordered lock", async () => {
  let advisoryLocks = 0;
  const locks: unknown[] = [];
  const insertedRows: unknown[] = [];
  const tx = asTestRaw<Transaction>({
    execute: async () => {
      advisoryLocks += 1;
    },
    insert: () => ({
      values: async (rows: unknown[]) => {
        insertedRows.push(...rows);
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async (strength: unknown) => {
              locks.push(strength);
              return [{ id: organizationId }];
            },
          }),
          orderBy: () => ({
            limit: () => ({
              for: async (strength: unknown) => {
                locks.push(strength);
                return [
                  { id: workspaceId, status: "active" },
                  { id: otherWorkspaceId, status: "active" },
                ];
              },
            }),
          }),
        }),
      }),
    }),
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) =>
      await Result.tryPromise({
        try: async () => await run(tx),
        catch: (cause) => cause,
      }),
  );

  const result = await reserveObjectCleanupIntents({
    objectKey: `${organizationId}/shared-object`,
    organizationId,
    safeDb,
    workspaceIds: [otherWorkspaceId, workspaceId],
  });

  if (Result.isError(result)) {
    throw result.error;
  }
  expect(advisoryLocks).toBe(1);
  expect(locks).toEqual(["share"]);
  expect(insertedRows).toEqual([
    expect.objectContaining({ workspaceId }),
    expect.objectContaining({ workspaceId: otherWorkspaceId }),
  ]);
});

test("reserves organization-scoped ownership without inventing a matter", async () => {
  let advisoryLocks = 0;
  const insertedRows: unknown[] = [];
  const tx = asTestRaw<Transaction>({
    execute: async () => {
      advisoryLocks += 1;
    },
    insert: () => ({
      values: async (rows: unknown[]) => {
        insertedRows.push(...rows);
      },
    }),
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) =>
      await Result.tryPromise({
        try: async () => await run(tx),
        catch: (cause) => cause,
      }),
  );

  const result = await reserveObjectCleanupIntents({
    objectKey: "user-id/global-chat-file",
    organizationId,
    safeDb,
    workspaceIds: [],
  });

  expect(result.status).toBe("ok");
  expect(advisoryLocks).toBe(1);
  expect(insertedRows).toEqual([
    expect.objectContaining({ workspaceId: null }),
  ]);
});

test("reserves chat ownership for archived scope while deletion stays fenced", async () => {
  const insertedRows: unknown[] = [];
  const tx = asTestRaw<Transaction>({
    execute: async () => undefined,
    insert: () => ({
      values: async (rows: unknown[]) => {
        insertedRows.push(...rows);
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              for: async () => [{ id: workspaceId, status: "archived" }],
            }),
          }),
        }),
      }),
    }),
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) =>
      await Result.tryPromise({
        try: async () => await run(tx),
        catch: (cause) => cause,
      }),
  );

  const result = await reserveObjectCleanupIntents({
    objectKey: "user-id/archived-chat-file",
    organizationId,
    safeDb,
    workspaceAvailability: OBJECT_INTENT_WORKSPACE_AVAILABILITY.NOT_DELETING,
    workspaceIds: [workspaceId],
  });

  expect(Result.isOk(result)).toBe(true);
  expect(insertedRows).toEqual([
    expect.objectContaining({
      status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
      workspaceId,
    }),
  ]);
});

test("holds every exact-key intent until its writer transaction settles", async () => {
  const locks: unknown[] = [];
  const tx = asTestRaw<Transaction>({
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (strength: unknown) => {
            locks.push(strength);
            return [
              {
                id: pendingUploadId,
                status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
              },
            ];
          },
        }),
      }),
    }),
  });

  await lockObjectCleanupIntentsForWriter(tx, [pendingUploadId]);

  expect(locks).toEqual(["update"]);
});

test("rejects a second settlement after writer ownership has transferred", async () => {
  const tx = asTestRaw<Transaction>({
    delete: () => ({
      where: () => ({ returning: async () => [] }),
    }),
  });

  expect(
    settleObjectCleanupIntentsAfterWriterInTransaction({
      intentIds: [pendingUploadId],
      objectState: "object-deleted",
      tx,
    }),
  ).rejects.toMatchObject({
    _tag: "BufferIntentOwnershipError",
    message: "Object cleanup settlement ownership was lost",
  });
});

test("transfers in-flight exact keys to lifecycle cleanup", async () => {
  const updates: unknown[] = [];
  const tx = asTestRaw<Transaction>({
    update: () => ({
      set: (values: unknown) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    }),
  });

  await releaseObjectCleanupIntentsForLifecycle(tx, {
    organizationId,
    type: "workspace",
    workspaceId,
  });

  expect(updates).toEqual([
    {
      attemptCount: 0,
      nextAttemptAt: expect.any(Date),
      status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
    },
  ]);
});

test("retires recovering cleanup ownership after the late-write quarantine", async () => {
  let retired = 0;
  const tx = asTestRaw<Transaction>({
    delete: () => ({
      where: async () => {
        retired += 1;
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              for: async () => [
                {
                  attemptCount: BUFFER_INTENT_RECOVERY_RETIRE_AFTER_ATTEMPTS,
                  id: pendingUploadId,
                  objectKey: `${organizationId}/${workspaceId}/recovered.docx`,
                  status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
                },
              ],
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) =>
      await Result.tryPromise({
        try: async () => await run(tx),
        catch: (cause) => cause,
      }),
  );

  const claimed = await reconcileBufferObjectCleanupIntents({
    deleteObject: s3DeleteMock,
    limit: 1,
    safeDb,
  });

  expect(claimed).toBe(1);
  expect(s3DeleteMock).toHaveBeenCalledTimes(1);
  expect(retired).toBe(1);
});

test("keeps a reclaimed writer intent recoverable after deleting its object", async () => {
  const updates: UpdateValues[] = [];

  const claimed = await reconcileStaleBufferIntentsGlobally({
    safeDb: createReconciliationSafeDb(updates),
    limit: 1,
    deleteObject: s3DeleteMock,
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

test("keeps a lifecycle tombstone while backing off repeated deletion", async () => {
  const updates: unknown[] = [];
  const tx = asTestRaw<Transaction>({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              for: async () => [
                {
                  attemptCount: 0,
                  id: pendingUploadId,
                  objectKey: `${organizationId}/${workspaceId}/reserved.docx`,
                  status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
                },
              ],
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: unknown) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    }),
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) =>
      await Result.tryPromise({
        try: async () => await run(tx),
        catch: (cause) => cause,
      }),
  );

  const claimed = await reconcileBufferObjectCleanupIntents({
    safeDb,
    limit: 1,
    deleteObject: s3DeleteMock,
  });

  expect(claimed).toBe(1);
  expect(s3DeleteMock).toHaveBeenCalledWith(
    `${organizationId}/${workspaceId}/reserved.docx`,
    expect.any(AbortSignal),
  );
  expect(updates).toHaveLength(1);
  expect(updates.at(0)).toEqual(
    expect.objectContaining({
      attemptCount: expect.anything(),
      nextAttemptAt: expect.anything(),
    }),
  );
});

test("retires orphaned cleanup ownership after exact-key deletion", async () => {
  let retired = 0;
  const tx = asTestRaw<Transaction>({
    delete: () => ({
      where: async () => {
        retired += 1;
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              for: async () => [
                {
                  attemptCount: 0,
                  id: pendingUploadId,
                  objectKey: `${organizationId}/${workspaceId}/orphan.docx`,
                  status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
                },
              ],
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) =>
      await Result.tryPromise({
        try: async () => await run(tx),
        catch: (cause) => cause,
      }),
  );

  const claimed = await reconcileBufferObjectCleanupIntents({
    deleteObject: s3DeleteMock,
    limit: 1,
    safeDb,
  });

  expect(claimed).toBe(1);
  expect(s3DeleteMock).toHaveBeenCalledTimes(1);
  expect(retired).toBe(1);
});

test("retains orphaned cleanup ownership when exact-key deletion fails", async () => {
  let retired = 0;
  const tx = asTestRaw<Transaction>({
    delete: () => ({
      where: async () => {
        retired += 1;
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              for: async () => [
                {
                  attemptCount: 0,
                  id: pendingUploadId,
                  objectKey: `${organizationId}/${workspaceId}/orphan.docx`,
                  status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
                },
              ],
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) =>
      await Result.tryPromise({
        try: async () => await run(tx),
        catch: (cause) => cause,
      }),
  );
  s3DeleteMock.mockRejectedValueOnce(new Error("object deletion failed"));

  const claimed = await reconcileBufferObjectCleanupIntents({
    deleteObject: s3DeleteMock,
    limit: 1,
    safeDb,
  });

  expect(claimed).toBe(1);
  expect(retired).toBe(0);
});

test("stops an in-flight object cleanup when the scheduler aborts", async () => {
  const updates: UpdateValues[] = [];
  let deletionStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    deletionStarted = resolve;
  });
  s3DeleteMock.mockImplementation(async (_key, signal: AbortSignal) => {
    deletionStarted?.();
    return await new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError"),
          ),
        { once: true },
      );
    });
  });
  const controller = new AbortController();
  const reconciliation = reconcileStaleBufferIntentsGlobally({
    safeDb: createReconciliationSafeDb(updates),
    limit: 1,
    signal: controller.signal,
    deleteObject: s3DeleteMock,
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
  expect(s3DeleteMock.mock.calls.at(0)?.at(1)).toMatchObject({ aborted: true });
});
