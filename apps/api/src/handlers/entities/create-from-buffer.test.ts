import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  documentCounters,
  entities,
  entityVersions,
  fields,
  properties,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const s3WriteMock = mock(async () => {});
const s3DeleteMock = mock(async () => {});
const processExtractionMock = mock(async () => {});
const enqueueImageThumbnailMock = mock(async () => {});
const enqueueImageThumbnailOrMarkFailedMock = mock(async () => {});
const enqueuePdfDerivativeMock = mock(async () => {});
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => {});

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({
    write: s3WriteMock,
    delete: s3DeleteMock,
  }),
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

const { createEntityFromBuffer } = await import("./create-from-buffer");

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000002",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000003");
const propertyId = toSafeId<"property">("00000000-0000-0000-0000-000000000004");
const parentId = toSafeId<"entity">("00000000-0000-0000-0000-000000000005");

describe("createEntityFromBuffer", () => {
  beforeEach(() => {
    s3WriteMock.mockClear();
    s3DeleteMock.mockClear();
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
      select: createTargetSelect({ parentKind: "folder" }),
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
    const { scopedDb } = createScopedDbMock(tx);

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
  });

  test("locks and rechecks the parent in the insert transaction", async () => {
    const locks: TargetLock[] = [];
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
      select: createTargetSelect({
        parentKind: null,
        onLock: (lock) => locks.push(lock),
      }),
    };
    const { getCallCount, scopedDb } = createScopedDbMock(tx);
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
    expect(getCallCount()).toBe(2);
    expect(locks).toEqual([
      { strength: "update", target: "property" },
      { strength: "update", target: "parent" },
    ]);
    expect(s3WriteMock).toHaveBeenCalledTimes(1);
    expect(s3DeleteMock).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

type TargetLock = {
  strength: unknown;
  target: "parent" | "property";
};

type CreateTargetSelectOptions = {
  parentKind: "document" | "folder" | null;
  onLock?: (lock: TargetLock) => void;
};

const createTargetSelect =
  ({ parentKind, onLock }: CreateTargetSelectOptions) =>
  (_selection: unknown) => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: () => ({
          for: async (strength: unknown) => {
            const target = table === properties ? "property" : "parent";
            onLock?.({ strength, target });

            if (table === properties) {
              return [{ content: { type: "file" as const }, id: propertyId }];
            }
            if (table === entities && parentKind !== null) {
              return [{ id: parentId, kind: parentKind }];
            }
            return [];
          },
        }),
      }),
    }),
  });
