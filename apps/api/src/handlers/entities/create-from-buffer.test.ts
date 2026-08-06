import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  bufferObjectCleanupIntents,
  documentCounters,
  entities,
  entityVersions,
  fields,
  pendingUploads,
  workspaces,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const s3WriteMock = mock(async () => {});
const s3DeleteMock = mock(async () => {});
const processExtractionMock = mock(async () => {});
const enqueueImageThumbnailMock = mock(async () => {});
const enqueueImageThumbnailOrMarkFailedMock = mock(async () => {});
const enqueuePdfDerivativeMock = mock(async () => {});
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => {});
const broadcastMock = mock();
let intentStatuses: string[] = [];

void mock.module("@/api/lib/s3", () => ({
  deleteS3ObjectWithSignal: s3DeleteMock,
  putS3ObjectWithSignal: s3WriteMock,
  // `mock.module` replaces the module, so every named export a consumer
  // imports must exist here or the import fails at link time. This suite
  // reads no object; throwing surfaces one that appears later.
  readS3ArrayBuffer: () => {
    throw new Error("Unexpected S3 object read in this suite");
  },
  readCorpusS3Bytes: () => {
    throw new Error("Unexpected corpus object read in this suite");
  },
}));

void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
}));

void mock.module("@/api/lib/file-derivative-queue", () => ({
  enqueueImageThumbnail: enqueueImageThumbnailMock,
  enqueueImageThumbnailOrMarkFailed: enqueueImageThumbnailOrMarkFailedMock,
  enqueuePdfDerivative: enqueuePdfDerivativeMock,
  enqueuePdfDerivativeOrMarkFailed: enqueuePdfDerivativeOrMarkFailedMock,
  initFileDerivativeWorker: mock(() => undefined),
}));

void mock.module("@/api/lib/sse", () => ({ broadcast: broadcastMock }));

const { createEntityFromBuffer } =
  await import("@/api/lib/entities/create-from-buffer");

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000002",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000003");
const propertyId = toSafeId<"property">("00000000-0000-0000-0000-000000000004");
const parentId = toSafeId<"entity">("00000000-0000-0000-0000-000000000005");

type IntentPersistenceBase = {
  [key: string]: unknown;
  delete?: (table: unknown) => unknown;
  insert?: (table: unknown) => unknown;
  select?: (selection: unknown) => unknown;
  update?: (table: unknown) => unknown;
};

const withIntentPersistence = (base: IntentPersistenceBase) => {
  const baseSelect = base.select;
  const baseDelete = base.delete;
  const baseInsert = base.insert;
  const baseUpdate = base.update;
  return {
    ...base,
    select: (selection: unknown) => baseSelect?.(selection),
    delete: (table: unknown) => {
      if (table === bufferObjectCleanupIntents) {
        return { where: async () => undefined };
      }
      return baseDelete?.(table);
    },
    insert: (table: unknown) => {
      if (table === pendingUploads) {
        return {
          values: (values: { id: string; status?: string }) => {
            if (values.status) {
              intentStatuses.push(values.status);
            }
            return { returning: async () => [{ id: values.id }] };
          },
        };
      }
      return baseInsert?.(table);
    },
    update: (table: unknown) => {
      if (table === pendingUploads) {
        return {
          set: (values: { status?: string }) => {
            if (values.status) {
              intentStatuses.push(values.status);
            }
            return {
              where: () => ({
                returning: async () => [{ id: "intent_1" }],
              }),
            };
          },
        };
      }
      return baseUpdate?.(table);
    },
  };
};

describe("createEntityFromBuffer", () => {
  beforeEach(() => {
    s3WriteMock.mockReset();
    s3WriteMock.mockResolvedValue(undefined);
    s3DeleteMock.mockReset();
    s3DeleteMock.mockResolvedValue(undefined);
    processExtractionMock.mockClear();
    broadcastMock.mockClear();
    intentStatuses = [];
  });

  test("rejects oversized documents before database or object-storage work", async () => {
    const { getCallCount, scopedDb } = createScopedDbMock({});

    const result = await createEntityFromBuffer({
      scopedDb,
      organizationId,
      workspaceId,
      userId,
      recordAuditEvent: async () => undefined,
      buffer: new Uint8Array(FILE_SIZE_LIMIT_BYTES.document + 1),
      fileName: "Oversized Agreement.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toEqual(
        expect.objectContaining({
          _tag: "DocumentTooLargeError",
          message: `Document exceeds the ${FILE_SIZE_LIMIT_BYTES.document}-byte size limit`,
        }),
      );
    }
    expect(getCallCount()).toBe(0);
    expect(s3WriteMock).not.toHaveBeenCalled();
    expect(s3DeleteMock).not.toHaveBeenCalled();
  });

  test("writes an entity create audit log with the DB insert", async () => {
    let nextDocumentSequence = 0;
    let insertedEntity: unknown;
    const tx = {
      query: {
        properties: {
          findMany: async () => [
            {
              id: propertyId,
              content: { type: "file" as const },
            },
          ],
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: createParentSelect({ parentKind: "folder" }),
      insert: (table: unknown) => ({
        values: (values: unknown) => {
          if (table === documentCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => {
                  nextDocumentSequence += 1;
                  return [{ lastValue: nextDocumentSequence }];
                },
              }),
            };
          }

          if (
            table === entities ||
            table === entityVersions ||
            table === fields
          ) {
            if (table === entities) {
              insertedEntity = values;
            }
            return undefined;
          }

          return undefined;
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => {},
        }),
      }),
    };
    const { scopedDb } = createScopedDbMock(withIntentPersistence(tx));

    const recordedAuditEvents: unknown[] = [];
    const result = await createEntityFromBuffer({
      scopedDb,
      organizationId,
      workspaceId,
      userId,
      recordAuditEvent: async (_tx, event) => {
        recordedAuditEvents.push(event);
      },
      buffer: new TextEncoder().encode("docx bytes"),
      fileName: "Generated Agreement.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      parentId,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(recordedAuditEvents).toHaveLength(1);
    expect(recordedAuditEvents.at(0)).toEqual({
      action: "create",
      changes: {
        created: {
          old: null,
          new: {
            kind: "document",
            fileName: "Generated Agreement.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 10,
            propertyId,
            parentId,
          },
        },
      },
      resourceId: expect.any(String),
      resourceType: "entity",
    });
    expect(insertedEntity).toEqual(
      expect.objectContaining({ parentId, workspaceId }),
    );
    expect(broadcastMock).toHaveBeenCalledWith(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });
  });

  test("locks and rechecks the parent in the insert transaction", async () => {
    const locks: unknown[] = [];
    const tx = {
      query: {
        properties: {
          findMany: async () => [
            {
              id: propertyId,
              content: { type: "file" as const },
            },
          ],
        },
      },
      $count: async () => 0,
      select: createParentSelect({
        parentKind: null,
        onLock: (strength) => {
          locks.push(strength);
        },
      }),
    };
    const { getCallCount, scopedDb } = createScopedDbMock(
      withIntentPersistence(tx),
    );
    const recordAuditEvent = mock(async () => {});

    const result = await createEntityFromBuffer({
      scopedDb,
      organizationId,
      workspaceId,
      userId,
      recordAuditEvent,
      buffer: new TextEncoder().encode("docx bytes"),
      fileName: "Generated Agreement.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      parentId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toEqual(
        expect.objectContaining({
          _tag: "InvalidParentError",
          message: "Parent entity not found in this workspace",
        }),
      );
    }
    expect(getCallCount()).toBe(4);
    expect(locks).toEqual(["share", "update"]);
    expect(s3WriteMock).toHaveBeenCalledTimes(1);
    expect(s3DeleteMock).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test("cleans up uploaded bytes when the in-transaction callback fails", async () => {
    const tx = {
      query: {
        properties: {
          findMany: async () => [
            { id: propertyId, content: { type: "file" as const } },
          ],
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: createParentSelect({ parentKind: "folder" }),
      insert: (table: unknown) => ({
        values: () =>
          table === documentCounters
            ? {
                onConflictDoUpdate: () => ({
                  returning: async () => [{ lastValue: 1 }],
                }),
              }
            : undefined,
      }),
      update: () => ({
        set: () => ({ where: async () => {} }),
      }),
    };
    const { scopedDb } = createScopedDbMock(withIntentPersistence(tx));

    const attempted = await Result.tryPromise({
      try: async () =>
        await createEntityFromBuffer({
          scopedDb,
          organizationId,
          workspaceId,
          userId,
          recordAuditEvent: async () => undefined,
          buffer: new TextEncoder().encode("docx bytes"),
          fileName: "Generated Agreement.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          parentId,
          afterCreate: async () => {
            throw new Error("audit failed");
          },
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted) && attempted.error instanceof Error) {
      expect(attempted.error.message).toBe("audit failed");
    }
    expect(s3DeleteMock).toHaveBeenCalledTimes(1);
    expect(processExtractionMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  test("keeps a failed-cleanup intent available for bounded reconciliation", async () => {
    const tx = {
      query: {
        properties: {
          findMany: async () => [
            { id: propertyId, content: { type: "file" as const } },
          ],
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: createParentSelect({ parentKind: "folder" }),
      insert: (table: unknown) => ({
        values: () =>
          table === documentCounters
            ? {
                onConflictDoUpdate: () => ({
                  returning: async () => [{ lastValue: 1 }],
                }),
              }
            : undefined,
      }),
      update: () => ({
        set: () => ({ where: async () => {} }),
      }),
    };
    const { scopedDb } = createScopedDbMock(withIntentPersistence(tx));
    s3DeleteMock.mockRejectedValue(new Error("object deletion timed out"));

    const attempted = await Result.tryPromise({
      try: async () =>
        await createEntityFromBuffer({
          scopedDb,
          organizationId,
          workspaceId,
          userId,
          recordAuditEvent: async () => undefined,
          buffer: new TextEncoder().encode("docx bytes"),
          fileName: "Generated Agreement.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          parentId,
          afterCreate: async () => {
            throw new Error("audit failed");
          },
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted) && attempted.error instanceof Error) {
      expect(attempted.error.message).toBe("audit failed");
    }
    expect(s3DeleteMock).toHaveBeenCalledTimes(1);
    expect(intentStatuses).toEqual(["scanning"]);
    expect(processExtractionMock).not.toHaveBeenCalled();
  });

  test("preserves bytes when the entity commit acknowledgement is ambiguous", async () => {
    let nextDocumentSequence = 0;
    const tx = withIntentPersistence({
      execute: async () => undefined,
      query: {
        properties: {
          findMany: async () => [
            { id: propertyId, content: { type: "file" as const } },
          ],
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: createParentSelect({ parentKind: "folder" }),
      insert: (table: unknown) => ({
        values: () =>
          table === documentCounters
            ? {
                onConflictDoUpdate: () => ({
                  returning: async () => {
                    nextDocumentSequence += 1;
                    return [{ lastValue: nextDocumentSequence }];
                  },
                }),
              }
            : undefined,
      }),
      update: () => ({
        set: () => ({ where: async () => {} }),
      }),
    });
    const commitError = new Error("connection lost after commit");
    let callCount = 0;
    const scopedDb = asTestRaw<ScopedDb>(
      async <T>(run: (transaction: Transaction) => Promise<T>) => {
        callCount += 1;
        const value = await run(asTestRaw<Transaction>(tx));
        if (callCount === 3) {
          throw commitError;
        }
        return value;
      },
    );

    const attempted = await Result.tryPromise({
      try: async () =>
        await createEntityFromBuffer({
          scopedDb,
          organizationId,
          workspaceId,
          userId,
          recordAuditEvent: async () => undefined,
          buffer: new TextEncoder().encode("docx bytes"),
          fileName: "Generated Agreement.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          parentId,
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      expect(attempted.error).toBe(commitError);
    }
    expect(intentStatuses).toEqual(["scanning", "finalized"]);
    expect(s3DeleteMock).not.toHaveBeenCalled();
    expect(processExtractionMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

type CreateParentSelectOptions = {
  parentKind: "document" | "folder" | null;
  onLock?: (strength: unknown) => void;
  workspaceStatus?: "active" | "deleting";
};

const createParentSelect =
  ({
    parentKind,
    onLock,
    workspaceStatus = "active",
  }: CreateParentSelectOptions) =>
  (_selection: unknown) => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: () => ({
          for: async (strength: unknown) => {
            onLock?.(strength);
            if (table === workspaces) {
              return [{ status: workspaceStatus }];
            }
            if (parentKind !== null) {
              return [{ id: parentId, kind: parentKind }];
            }
            return [];
          },
        }),
      }),
    }),
  });
