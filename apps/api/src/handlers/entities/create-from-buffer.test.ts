import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const processExtractionMock = mock(async () => {});
const enqueueImageThumbnailOrMarkFailedMock = mock(async () => {});
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => {});
const broadcastMock = mock();
let intentStatuses: string[] = [];

const createEntityFromBufferDependencies = {
  broadcastWorkspaceResourceUpdated: (workspaceId, resource) => {
    broadcastWorkspaceResourceUpdated(workspaceId, resource, (id, event) => {
      broadcastMock(id, event);
    });
  },
  enqueueImageThumbnailOrMarkFailed: enqueueImageThumbnailOrMarkFailedMock,
  enqueuePdfDerivativeOrMarkFailed: enqueuePdfDerivativeOrMarkFailedMock,
  processExtraction: processExtractionMock,
  requestNativeExtractionRun: mock(async () => null),
} satisfies CreateEntityFromBufferDependencies;

const createEntityFromBufferForTest = async (
  input: Omit<Parameters<typeof createEntityFromBuffer>[0], "dependencies">,
) =>
  await createEntityFromBuffer({
    ...input,
    dependencies: createEntityFromBufferDependencies,
  });

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000002",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000003");
const propertyId = toSafeId<"property">("00000000-0000-0000-0000-000000000004");
const parentId = toSafeId<"entity">("00000000-0000-0000-0000-000000000005");
const sourceEntityId = toSafeId<"entity">(
  "00000000-0000-0000-0000-000000000006",
);
const sourceFieldId = toSafeId<"field">("00000000-0000-0000-0000-000000000007");

// The writer runs against a real store, so "the bytes were published" and
// "the bytes were reclaimed" are read back from it instead of from a spy.
let fake: FakeS3;

const objectKeysInStore = (): string[] => [...fake.objects.keys()];

const requestKeys = (method: "DELETE" | "PUT"): string[] =>
  fake.requests
    .filter((request) => request.method === method)
    .map(({ key }) => key);

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
    fake = startFakeS3();
    processExtractionMock.mockClear();
    enqueueImageThumbnailOrMarkFailedMock.mockClear();
    enqueuePdfDerivativeOrMarkFailedMock.mockClear();
    broadcastMock.mockClear();
    intentStatuses = [];
  });

  afterEach(() => {
    fake.stop();
  });

  test("rejects oversized documents before database or object-storage work", async () => {
    const { getCallCount, scopedDb } = createScopedDbMock({});

    const result = await createEntityFromBufferForTest({
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
    // The size gate runs before any object-storage request at all.
    expect(fake.requests).toEqual([]);
  });

  test("writes an entity create audit log with the DB insert", async () => {
    let nextDocumentSequence = 0;
    let insertedEntity: unknown;
    let insertedField: unknown;
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
            if (table === fields) {
              insertedField = values;
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
    const result = await createEntityFromBufferForTest({
      scopedDb,
      organizationId,
      workspaceId,
      userId,
      recordAuditEvent: async (_tx, event) => {
        recordedAuditEvents.push(event);
      },
      buffer: new TextEncoder().encode("pdf bytes"),
      fileName: "Encrypted Agreement.pdf",
      mimeType: "application/pdf",
      encrypted: true,
      parentId,
      provenance: {
        type: "email_attachment",
        attachmentId: "ea1.example",
        sourceEntityId,
        sourceFieldId,
        sourceWorkspaceId: workspaceId,
      },
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
            fileName: "Encrypted Agreement.pdf",
            mimeType: "application/pdf",
            sizeBytes: 9,
            propertyId,
            parentId,
          },
        },
      },
      metadata: {
        provenance: {
          type: "email_attachment",
          attachmentId: "ea1.example",
          sourceEntityId,
          sourceFieldId,
          sourceWorkspaceId: workspaceId,
        },
      },
      resourceId: expect.any(String),
      resourceType: "entity",
    });
    expect(insertedEntity).toEqual(
      expect.objectContaining({ parentId, workspaceId }),
    );
    expect(insertedField).toEqual(
      expect.objectContaining({
        content: expect.objectContaining({ encrypted: true }),
      }),
    );
    expect(enqueuePdfDerivativeOrMarkFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ encrypted: true }),
    );
    expect(enqueueImageThumbnailOrMarkFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ encrypted: true }),
    );
    expect(broadcastMock).toHaveBeenCalledWith(workspaceId, {
      type: "resource.updated",
      resource: { type: "entity", id: expect.any(String) },
    });
    // The committed entity keeps exactly one published object, stored under
    // the declared type.
    const publishedKey = objectKeysInStore().at(0);
    expect(objectKeysInStore()).toHaveLength(1);
    expect(fake.objects.get(publishedKey ?? "")).toEqual({
      bytes: new TextEncoder().encode("pdf bytes"),
      contentType: "application/pdf",
    });
    expect(requestKeys("DELETE")).toEqual([]);
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

    const result = await createEntityFromBufferForTest({
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
    // The rejected parent leaves nothing behind: the published object is
    // reclaimed under the same key it was written to.
    expect(requestKeys("PUT")).toHaveLength(1);
    expect(requestKeys("DELETE")).toEqual(requestKeys("PUT"));
    expect(objectKeysInStore()).toEqual([]);
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
        await createEntityFromBufferForTest({
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
    expect(requestKeys("DELETE")).toEqual(requestKeys("PUT"));
    expect(objectKeysInStore()).toEqual([]);
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
    fake.failNext({ method: "DELETE", code: "AccessDenied", status: 403 });

    const attempted = await Result.tryPromise({
      try: async () =>
        await createEntityFromBufferForTest({
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
    // The store rejected the cleanup, so the bytes are still published and
    // the intent has to stay for the bounded reconciler to finish the job.
    expect(requestKeys("DELETE")).toEqual(requestKeys("PUT"));
    expect(objectKeysInStore()).toEqual(
      requestKeys("PUT").map((key) => `${envBase.S3_BUCKET}/${key}`),
    );
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
        await createEntityFromBufferForTest({
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
    // An ambiguous commit must never take the bytes the entity may reference.
    expect(requestKeys("DELETE")).toEqual([]);
    expect(objectKeysInStore()).toEqual(
      requestKeys("PUT").map((key) => `${envBase.S3_BUCKET}/${key}`),
    );
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
