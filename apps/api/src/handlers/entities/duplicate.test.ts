import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  auditLogs,
  documentCounters,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { envBase } from "@/api/env-base";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
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
const realDocumentProcessingEnqueue =
  await import("@/api/lib/document-processing-enqueue");
void mock.module("@/api/lib/document-processing-enqueue", () => ({
  ...realDocumentProcessingEnqueue,
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

// The duplicate runs against a real store: every copy is a server-side copy
// of this object, so the key a copy lands under and the file id persisted on
// the duplicated field have to agree.
const sourceBytes = new TextEncoder().encode("child docx bytes");
const sourceKey = createFileKey({
  organizationId,
  workspaceId,
  fileId: fileContent.id,
  mimeType: fileContent.mimeType,
});

let fake: FakeS3;

beforeEach(() => {
  fake = startFakeS3();
  fake.put(envBase.S3_BUCKET, sourceKey, sourceBytes, fileContent.mimeType);
});

afterEach(() => {
  fake.stop();
});

test("reserves a copy destination before an ambiguous S3 failure", async () => {
  // A rejected copy is ambiguous: the object may still have landed, so the
  // destination has to be reserved before the request goes out.
  fake.failNext({ method: "COPY", code: "AccessDenied", status: 403 });
  const copiedS3Keys: string[] = [];

  // bun-types declares `.rejects.toBe` as void, so capture the rejection
  // explicitly for both type-aware lint and the runtime assertion.
  const rejection: unknown = await copyFileObject({
    sourceEntityId: documentId,
    sourceFileId: fileContent.id,
    sourcePropertyId: propertyId,
    sourceKey,
    mimeType: fileContent.mimeType,
    organizationId,
    targetWorkspaceId: workspaceId,
    copiedS3Keys,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(rejection).toMatchObject({ message: "Failed to copy object" });
  const attempted = fake.requests.filter(({ method }) => method === "COPY");
  expect(attempted).toHaveLength(1);
  // The reserved key is the key the copy actually addressed, not a guess.
  expect(copiedS3Keys).toEqual(attempted.map(({ key }) => key));
  expect(attempted.at(0)?.copySourceKey).toBe(sourceKey);
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
      // The duplicate owns its own object, and the field points at it: the
      // key derived from the persisted file id holds the source bytes.
      const copyKey = createFileKey({
        organizationId,
        workspaceId,
        fileId: duplicatedFileField.content.id,
        mimeType: fileContent.mimeType,
      });
      expect(fake.objects.get(`${envBase.S3_BUCKET}/${copyKey}`)).toEqual({
        bytes: sourceBytes,
        contentType: fileContent.mimeType,
      });
    }
    expect(
      fake.requests.filter(({ method }) => method === "COPY"),
    ).toHaveLength(1);

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
    expect(enqueueDocumentProcessingRunMock.mock.calls).toEqual([
      [toSafeId<"documentProcessingRun">("run_0")],
    ]);
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
    const copiedKeys = fake.requests
      .filter(({ method }) => method === "COPY")
      .map(({ key }) => key);
    const deletedKeys = fake.requests
      .filter(({ method }) => method === "DELETE")
      .map(({ key }) => key);
    expect(copiedKeys).toHaveLength(1);
    expect(new Set(deletedKeys)).toEqual(new Set(copiedKeys));
    // The store is back to the source object alone.
    expect([...fake.objects.keys()]).toEqual([
      `${envBase.S3_BUCKET}/${sourceKey}`,
    ]);

    // Nothing is indexed for copies that no longer exist.
    expect(enqueueEntitySearchRepairsMock).not.toHaveBeenCalled();
    expect(flushEntitySearchRepairsMock).not.toHaveBeenCalled();
    expect(enqueueDocumentProcessingRunMock).not.toHaveBeenCalled();
  });
});
