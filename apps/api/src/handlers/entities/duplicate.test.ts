import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import {
  auditLogs,
  documentCounters,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

// Spread the real module: the copy helper reads its search-index ownership
// split from here. Only the durable extraction request itself is replaced.
const realProcessExtraction =
  await import("@/api/lib/search/process-extraction");
const requestNativeExtractionRunsMock = mock(
  async ({ requests }: { requests: readonly unknown[] }) =>
    requests.map((_, index) =>
      toSafeId<"documentProcessingRun">(`run_${index}`),
    ),
);
void mock.module("@/api/lib/search/process-extraction", () => ({
  ...realProcessExtraction,
  requestNativeExtractionRun: mock(async () => null),
  requestNativeExtractionRuns: requestNativeExtractionRunsMock,
}));

const enqueueDocumentProcessingRunMock = mock(
  async (_runId: SafeId<"documentProcessingRun">) => undefined,
);
void mock.module("@/api/lib/document-processing-enqueue", () => ({
  enqueueDocumentProcessingRun: enqueueDocumentProcessingRunMock,
}));

const enqueueEntitySearchRepairsMock = mock(
  async (_tx: unknown, _entityIds: readonly string[]) => undefined,
);
const flushEntitySearchRepairsMock = mock(async () => ({
  failed: 0,
  repaired: 0,
}));
// The full export set, not just the two this suite asserts on: a partial
// factory silently leaves the rest of the module real, so a consumer reaching
// the queue through another entry point would open a transaction here.
const idleRepairOutcome = async () => ({ failed: 0, repaired: 0 });
void mock.module("@/api/lib/search/projection-repair-queue", () => ({
  SEARCH_PROJECTION_REPAIR_BATCH_SIZE: 32,
  drainSearchProjectionRepairQueue: idleRepairOutcome,
  enqueueContactSearchRepairs: async () => undefined,
  enqueueEntitySearchRepairs: enqueueEntitySearchRepairsMock,
  enqueueWorkspaceSearchRepairs: async () => undefined,
  flushContactSearchRepairs: idleRepairOutcome,
  flushEntitySearchRepairs: flushEntitySearchRepairsMock,
  flushWorkspaceSearchRepairs: idleRepairOutcome,
}));

const fileMock = mock(() => ({}));
// Typed by their first argument so a test can read back the object keys the
// copy wrote and the keys the rollback returned.
const writeMock = mock(async (_key: string) => undefined);
const s3DeleteMock = mock(async (_key: string) => undefined);
const copyObjectMock = mock<
  (sourceKey: string, targetKey: string) => Promise<Result<void, unknown>>
>(async () => Result.ok(undefined));

// Spread the real module: mock.module is process-global; a partial mock would delete s3's other exports for later test files.
const realS3 = await import("@/api/lib/s3");

void mock.module("@/api/lib/s3", () => ({
  ...realS3,
  deleteS3ObjectWithSignal: s3DeleteMock,
  getS3: () => ({ delete: s3DeleteMock, file: fileMock, write: writeMock }),
  putS3ObjectWithSignal: writeMock,
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

const realS3Presign = await import("@/api/lib/s3-presign");
void mock.module("@/api/lib/s3-presign", () => ({
  ...realS3Presign,
  copyObject: copyObjectMock,
}));

const { default: duplicateEntity } = await import("./duplicate");
const { copyFileObject } = await import("./copy-utils");

const workspaceId = toSafeId<"workspace">("workspace_1");
const userId = toSafeId<"user">("user_1");
const organizationId = toSafeId<"organization">("organization_1");
const rootFolderId = toSafeId<"entity">("root_folder");
const documentId = toSafeId<"entity">("document_child");
const nestedFolderId = toSafeId<"entity">("nested_folder");
const propertyId = toSafeId<"property">("property_1");

const fileContent = {
  type: "file",
  version: 1,
  id: Bun.randomUUIDv7(),
  fileName: "Child.docx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sizeBytes: 123,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
} satisfies FieldContent;

test("reserves a copy destination before an ambiguous S3 failure", async () => {
  copyObjectMock.mockClear();
  const copyError = new Error("copy response lost");
  copyObjectMock.mockImplementationOnce(async () => Result.err(copyError));
  const copiedS3Keys: string[] = [];

  // bun-types declares `.rejects.toBe` as void, so capture the rejection
  // explicitly for both type-aware lint and the runtime assertion.
  const rejection: unknown = await copyFileObject({
    sourceEntityId: documentId,
    sourceFileId: fileContent.id,
    sourcePropertyId: propertyId,
    sourceKey: "organizations/source/workspaces/source/files/source.docx",
    mimeType: fileContent.mimeType,
    organizationId,
    targetWorkspaceId: workspaceId,
    copiedS3Keys,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(rejection).toBe(copyError);
  const targetKey = copyObjectMock.mock.calls.at(-1)?.at(1);
  if (!targetKey) {
    throw new Error("Expected copyObject to receive a target key");
  }
  expect(copiedS3Keys).toEqual([targetKey]);
});

type InsertedEntity = {
  id: SafeId<"entity">;
  kind: string;
  name: string | null;
  parentId: SafeId<"entity"> | null;
  docSequence?: number | null;
};

type InsertedField = {
  content: FieldContent;
};

const isInsertedEntity = (value: unknown): value is InsertedEntity =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  "kind" in value &&
  "name" in value &&
  "parentId" in value;

const isInsertedField = (value: unknown): value is InsertedField =>
  typeof value === "object" && value !== null && "content" in value;

const isArrayWithLength = (
  value: unknown,
  length: number,
): value is unknown[] => Array.isArray(value) && value.length === length;

const sourceEntities = [
  {
    id: rootFolderId,
    kind: "folder" as const,
    name: "Root",
    parentId: null,
    currentVersion: { fields: [] },
  },
  {
    id: documentId,
    kind: "document" as const,
    name: "Child.docx",
    parentId: rootFolderId,
    currentVersion: {
      fields: [{ propertyId, content: fileContent }],
    },
  },
  {
    id: nestedFolderId,
    kind: "folder" as const,
    name: "Nested",
    parentId: rootFolderId,
    currentVersion: { fields: [] },
  },
];

const createContext = ({
  safeDb,
}: {
  safeDb: Parameters<typeof duplicateEntity.handler>[0]["safeDb"];
}): Parameters<typeof duplicateEntity.handler>[0] => {
  const recorderBindings = {
    organizationId,
    workspaceId,
    userId,
    request: new Request("https://example.test/v1/entities/duplicate"),
    server: null,
  };

  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture only provides fields touched by the handler
  return {
    workspaceId,
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
    memberRole: { role: "owner" },
    body: { entityId: rootFolderId },
    request: recorderBindings.request,
    route: "/v1/entities/:workspaceId/duplicate",
    safeDb,
    recordAuditEvent: createAuditRecorder(recorderBindings),
    createAuditRecorder: () => createAuditRecorder(recorderBindings),
  } as Parameters<typeof duplicateEntity.handler>[0];
};

describe("duplicate entity", () => {
  test("duplicates folder trees instead of rejecting folders", async () => {
    copyObjectMock.mockClear();
    requestNativeExtractionRunsMock.mockClear();
    enqueueDocumentProcessingRunMock.mockClear();
    enqueueEntitySearchRepairsMock.mockClear();
    flushEntitySearchRepairsMock.mockClear();

    const insertedEntities: InsertedEntity[] = [];
    const insertedVersions: unknown[] = [];
    const insertedFields: unknown[] = [];
    const insertedAuditLogs: unknown[] = [];
    let nextDocumentSequence = 0;

    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceEntities.at(0),
          findMany: async () => sourceEntities,
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => sourceEntities.length,
      select: () => ({
        from: () => ({
          where: async () =>
            sourceEntities.map((entity) => ({ name: entity.name })),
        }),
      }),
      insert: (table: unknown) => ({
        values: (value: unknown) => {
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

          if (table === entities) {
            if (!isInsertedEntity(value)) {
              throw new Error("Invalid inserted entity fixture value");
            }
            insertedEntities.push(value);
          } else if (table === entityVersions) {
            insertedVersions.push(value);
          } else if (table === fields) {
            insertedFields.push(value);
          } else if (table === auditLogs) {
            insertedAuditLogs.push(value);
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

    const { safeDb } = createScopedDbMock(tx);
    const result = await duplicateEntity.handler(createContext({ safeDb }));

    expect(result).toEqual({
      entityId: expect.any(String),
    });
    expect(insertedEntities).toHaveLength(3);
    expect(insertedVersions).toHaveLength(3);
    expect(insertedFields).toHaveLength(1);
    expect(insertedAuditLogs).toHaveLength(1);
    const auditBatch = insertedAuditLogs.at(0);
    expect(isArrayWithLength(auditBatch, 3)).toBe(true);
    const fieldBatch = insertedFields.at(0);
    expect(isArrayWithLength(fieldBatch, 1)).toBe(true);
    if (!isArrayWithLength(fieldBatch, 1)) {
      throw new Error("Expected duplicated file field batch");
    }

    const duplicatedFileField = fieldBatch.at(0);
    expect(isInsertedField(duplicatedFileField)).toBe(true);
    if (!isInsertedField(duplicatedFileField)) {
      throw new Error("Expected duplicated file field");
    }
    expect(duplicatedFileField.content.type).toBe("file");
    if (duplicatedFileField.content.type === "file") {
      expect(duplicatedFileField.content.id).not.toBe(fileContent.id);
    }
    expect(copyObjectMock).toHaveBeenCalledTimes(1);

    const rootDuplicate = insertedEntities.at(0);
    const documentDuplicate = insertedEntities.at(1);
    const nestedDuplicate = insertedEntities.at(2);

    expect(rootDuplicate).toBeDefined();
    expect(documentDuplicate).toBeDefined();
    expect(nestedDuplicate).toBeDefined();
    if (!rootDuplicate || !documentDuplicate || !nestedDuplicate) {
      throw new Error("Expected all duplicated entities to be inserted");
    }

    expect(rootDuplicate.kind).toBe("folder");
    expect(rootDuplicate.name).toBe("Root_1");
    expect(rootDuplicate.parentId).toBeNull();
    expect(documentDuplicate.kind).toBe("document");
    expect(documentDuplicate.name).toBe("Child.docx");
    expect(documentDuplicate.parentId).toBe(rootDuplicate.id);
    expect(documentDuplicate.docSequence).toBe(1);
    expect(nestedDuplicate.kind).toBe("folder");
    expect(nestedDuplicate.name).toBe("Nested");
    expect(nestedDuplicate.parentId).toBe(rootDuplicate.id);
    // The DOCX copy is indexed by the extraction run that reads it; the two
    // folder copies have no such run, so their marks are written inside the
    // copy transaction and only flushed afterwards.
    expect(requestNativeExtractionRunsMock).toHaveBeenCalledTimes(1);
    expect(enqueueDocumentProcessingRunMock.mock.calls).toEqual([["run_0"]]);
    expect(enqueueEntitySearchRepairsMock).toHaveBeenCalledTimes(1);
    expect(enqueueEntitySearchRepairsMock.mock.calls.at(0)?.at(1)).toEqual([
      rootDuplicate.id,
      nestedDuplicate.id,
    ]);
    expect(flushEntitySearchRepairsMock).toHaveBeenCalledTimes(1);
  });

  test("returns every object copied for an aborted duplicate", async () => {
    requestNativeExtractionRunsMock.mockClear();
    enqueueDocumentProcessingRunMock.mockClear();
    enqueueEntitySearchRepairsMock.mockClear();
    flushEntitySearchRepairsMock.mockClear();
    copyObjectMock.mockClear();
    s3DeleteMock.mockClear();

    // The nested folder is the third entity in copy order, so the root and
    // the document (and the document's copied object) are already written
    // when the copy rejects.
    const brokenSubtree = [
      ...sourceEntities.slice(0, 2),
      {
        id: nestedFolderId,
        kind: "folder" as const,
        name: "Nested",
        parentId: rootFolderId,
        currentVersion: null,
      },
    ];

    const tx = {
      query: {
        entities: {
          findFirst: async () => brokenSubtree.at(0),
          findMany: async () => brokenSubtree,
        },
        workspaces: { findFirst: async () => ({ reference: null }) },
      },
      $count: async () => brokenSubtree.length,
      select: () => ({
        from: () => ({
          where: async () =>
            brokenSubtree.map((entity) => ({ name: entity.name })),
        }),
      }),
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
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };

    const { safeDb } = createScopedDbMock(tx);
    const result = await duplicateEntity.handler(createContext({ safeDb }));

    // The abort travels as the same rejection the caller always answered.
    expect(result).toMatchObject({
      code: 400,
      response: { message: "Entity has no current version" },
    });

    // No row survives the abort, so every object copied for it is an orphan
    // and all of them go back.
    const copiedKeys = copyObjectMock.mock.calls.map(
      ([_sourceKey, targetKey]) => targetKey,
    );
    const deletedKeys = s3DeleteMock.mock.calls.map(([key]) => key);
    expect(copiedKeys).toHaveLength(1);
    expect(new Set(deletedKeys)).toEqual(new Set(copiedKeys));

    // Nothing is indexed for copies that no longer exist.
    expect(enqueueEntitySearchRepairsMock).not.toHaveBeenCalled();
    expect(flushEntitySearchRepairsMock).not.toHaveBeenCalled();
    expect(enqueueDocumentProcessingRunMock).not.toHaveBeenCalled();
  });
});
