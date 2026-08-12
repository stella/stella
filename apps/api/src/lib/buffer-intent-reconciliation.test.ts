import { Result } from "better-result";
import { beforeEach, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { bufferObjectCleanupIntents, pendingUploads } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const s3DeleteMock = mock(
  async (_key: string, _signal: AbortSignal) => undefined,
);

const {
  lockActiveWorkspaceForBufferIntent,
  pendingUploadRecoveryObjectKeys,
  reconcileBufferObjectCleanupIntents,
  reconcileStaleBufferIntentsGlobally,
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

type UpdateValues = {
  claimedAt?: Date | undefined;
  finalizedAt?: Date | undefined;
  status?: string | undefined;
};

type ReconciliationRow = Parameters<typeof pendingUploadRecoveryObjectKeys>[0];
type CleanupIntentRow = Pick<
  typeof bufferObjectCleanupIntents.$inferSelect,
  "attemptCount" | "id" | "objectKey"
>;

const createReconciliationSafeDb = (
  updates: UpdateValues[],
  rows: ReconciliationRow[] = [
    {
      declaredMime:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      id: pendingUploadId,
      organizationId,
      purpose: "entity_create",
      purposeData: {
        type: "entity_create" as const,
        propertyId: toSafeId<"property">(
          "00000000-0000-0000-0000-000000000004",
        ),
        reservedFileId: "00000000-0000-0000-0000-000000000005",
      },
      workspaceId,
    },
  ],
  cleanupIntentRows: CleanupIntentRow[] = [],
): SafeDb =>
  asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) => {
      const tx = asTestRaw<Transaction>({
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  for: async () => {
                    if (table === pendingUploads) {
                      return rows;
                    }
                    if (table === bufferObjectCleanupIntents) {
                      return cleanupIntentRows;
                    }
                    return [];
                  },
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
      return await Result.tryPromise({
        try: async () => await run(tx),
        catch: (cause) => cause,
      });
    },
  );

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
          limit: () => ({
            for: async (strength: unknown) => {
              locks.push(strength);
              return [{ status: "active" }];
            },
          }),
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
          limit: () => ({ for: async () => [{ status: "deleting" }] }),
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
});

test("enumerates every persisted email-ingest recovery object", () => {
  const recoveryObjectKeys = [
    `${organizationId}/${workspaceId}/message.eml`,
    `${organizationId}/${workspaceId}/attachment.pdf`,
  ];

  expect(
    pendingUploadRecoveryObjectKeys({
      declaredMime: "message/rfc822",
      id: pendingUploadId,
      organizationId,
      purpose: "email_ingest",
      purposeData: {
        type: "email_ingest",
        propertyId: toSafeId<"property">(
          "00000000-0000-0000-0000-000000000004",
        ),
        recoveryObjectKeys,
      },
      workspaceId,
    }),
  ).toEqual(recoveryObjectKeys);
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

test("shares one bounded cleanup pool across claimed email ingests", async () => {
  const rows = [0, 1, 2, 3, 4, 5].map(
    (rowIndex) =>
      ({
        declaredMime: "message/rfc822",
        id: toSafeId<"pendingUpload">(
          `00000000-0000-0000-0000-${String(rowIndex + 10).padStart(12, "0")}`,
        ),
        organizationId,
        purpose: "email_ingest",
        purposeData: {
          type: "email_ingest",
          propertyId: toSafeId<"property">(
            "00000000-0000-0000-0000-000000000004",
          ),
          recoveryObjectKeys: Array.from(
            { length: 5 },
            (_, objectIndex) =>
              `${organizationId}/${workspaceId}/${String(rowIndex)}-${String(objectIndex)}`,
          ),
        },
        workspaceId,
      }) satisfies ReconciliationRow,
  );
  let active = 0;
  let maximumActive = 0;
  let deletionCount = 0;

  const claimed = await reconcileStaleBufferIntentsGlobally({
    safeDb: createReconciliationSafeDb([], rows),
    limit: 25,
    deleteObject: async () => {
      active += 1;
      deletionCount += 1;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(1);
      active -= 1;
    },
  });

  expect(claimed).toBe(6);
  expect(deletionCount).toBe(30);
  expect(maximumActive).toBe(4);
});

test("lets lifecycle tombstones progress fairly through the shared pool", async () => {
  const pendingKeyPrefix = `${organizationId}/${workspaceId}/pending`;
  const tombstoneKey = `${organizationId}/${workspaceId}/tombstone`;
  const row = {
    declaredMime: "message/rfc822",
    id: pendingUploadId,
    organizationId,
    purpose: "email_ingest",
    purposeData: {
      type: "email_ingest",
      propertyId: toSafeId<"property">("00000000-0000-0000-0000-000000000004"),
      recoveryObjectKeys: Array.from(
        { length: 8 },
        (_, index) => `${pendingKeyPrefix}-${String(index)}`,
      ),
    },
    workspaceId,
  } satisfies ReconciliationRow;
  const startedKeys: string[] = [];
  let active = 0;
  let maximumActive = 0;

  const claimed = await reconcileStaleBufferIntentsGlobally({
    safeDb: createReconciliationSafeDb(
      [],
      [row],
      [{ attemptCount: 0, id: pendingUploadId, objectKey: tombstoneKey }],
    ),
    limit: 2,
    deleteObject: async (objectKey) => {
      startedKeys.push(objectKey);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(1);
      active -= 1;
    },
  });

  expect(claimed).toBe(2);
  expect(maximumActive).toBe(4);
  expect(startedKeys.indexOf(tombstoneKey)).toBeLessThan(8);
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

test("claims only the selected object-key tombstones for a shared upload id", async () => {
  const objectKeys = [
    `${organizationId}/${workspaceId}/message.eml`,
    `${organizationId}/${workspaceId}/attachment-a.pdf`,
    `${organizationId}/${workspaceId}/attachment-b.pdf`,
  ];
  const rows = objectKeys.map((objectKey) => ({
    attemptCount: 0,
    id: pendingUploadId,
    objectKey,
  }));
  let updateCondition: SQL | undefined;
  const tx = asTestRaw<Transaction>({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              for: async () => rows.slice(0, 2),
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async (condition: SQL) => {
          updateCondition = condition;
        },
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

  const claimed = await reconcileBufferObjectCleanupIntents({
    safeDb,
    limit: 2,
    deleteObject: s3DeleteMock,
  });

  expect(claimed).toBe(2);
  expect(s3DeleteMock).toHaveBeenCalledTimes(2);
  expect(updateCondition).toBeDefined();
  if (!updateCondition) {
    throw new Error("Expected composite tombstone claim predicate");
  }

  const compiled = new PgDialect().sqlToQuery(updateCondition);
  expect(compiled.params).toEqual([
    pendingUploadId,
    objectKeys[0],
    pendingUploadId,
    objectKeys[1],
  ]);
  expect(compiled.params).not.toContain(objectKeys[2]);
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
