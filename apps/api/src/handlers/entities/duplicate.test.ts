import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
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
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { createFileKey } from "@/api/lib/file-key";
import { entityVersionInsertResult } from "@/api/tests/helpers/entity-version-insert-mock";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { copyFileObject, resolveEntityName } from "./copy-utils";
import { createDuplicateEntity } from "./duplicate";

const requestNativeExtractionRunsMock = mock(
  async ({ requests }: { requests: readonly unknown[] }) =>
    requests.map((_, index) =>
      toSafeId<"documentProcessingRun">(`run_${index}`),
    ),
);
const enqueueDocumentProcessingRunMock = mock(
  async (_runId: SafeId<"documentProcessingRun">) => undefined,
);

const enqueueEntitySearchRepairsMock = mock(
  async (_tx: unknown, _entityIds: readonly string[]) => undefined,
);
const flushEntitySearchRepairsMock = mock(async () => ({
  failed: 0,
  repaired: 0,
}));
const duplicateEntity = createDuplicateEntity({
  enqueueDocumentProcessingRun: enqueueDocumentProcessingRunMock,
  enqueueEntitySearchRepairs: enqueueEntitySearchRepairsMock,
  flushEntitySearchRepairs: flushEntitySearchRepairsMock,
  requestNativeExtractionRuns: requestNativeExtractionRunsMock,
});

const workspaceId = toSafeId<"workspace">("workspace_1");
const userId = toSafeId<"user">("user_1");
const organizationId = toSafeId<"organization">("organization_1");
const rootFolderId = toSafeId<"entity">("root_folder");
const documentId = toSafeId<"entity">("document_child");
const nestedFolderId = toSafeId<"entity">("nested_folder");
const requestedDuplicateId = toSafeId<"entity">("requested_duplicate");
const propertyId = toSafeId<"property">("property_1");
const secondaryPropertyId = toSafeId<"property">("property_2");
const sourceFileFieldId = toSafeId<"field">("source_file_field");
const secondaryFileFieldId = toSafeId<"field">("secondary_file_field");

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

const secondaryFileContent = {
  ...fileContent,
  id: Bun.randomUUIDv7(),
  fileName: "Schedule.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sha256Hex: "b".repeat(64),
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
const secondarySourceKey = createFileKey({
  organizationId,
  workspaceId,
  fileId: secondaryFileContent.id,
  mimeType: secondaryFileContent.mimeType,
});

let fake: FakeS3;

beforeEach(() => {
  fake = startFakeS3();
  fake.put(envBase.S3_BUCKET, sourceKey, sourceBytes, fileContent.mimeType);
  fake.put(
    envBase.S3_BUCKET,
    secondarySourceKey,
    sourceBytes,
    secondaryFileContent.mimeType,
  );
});

afterEach(() => {
  fake.stop();
});

test("reserves a copy destination before an ambiguous S3 failure", async () => {
  // A rejected copy is ambiguous: the object may still have landed, so the
  // destination has to be reserved before the request goes out.
  fake.failNext({ method: "COPY", code: "AccessDenied", status: 403 });
  const copiedS3Keys: string[] = [];

  const copied = await copyFileObject({
    sourceEntityId: documentId,
    sourceFileId: fileContent.id,
    sourceKey,
    mimeType: fileContent.mimeType,
    organizationId,
    targetWorkspaceId: workspaceId,
    copiedS3Keys,
  });

  if (!Result.isError(copied)) {
    throw new TypeError("Expected the ambiguous copy to fail");
  }
  expect(copied.error).toMatchObject({ message: "Failed to copy object" });
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
    currentVersion: {
      id: toSafeId<"entityVersion">("version_root"),
      fields: [],
    },
  },
  {
    id: documentId,
    kind: "document" as const,
    name: "Child.docx",
    parentId: rootFolderId,
    currentVersion: {
      id: toSafeId<"entityVersion">("version_child"),
      fields: [{ id: sourceFileFieldId, propertyId, content: fileContent }],
    },
  },
  {
    id: nestedFolderId,
    kind: "folder" as const,
    name: "Nested",
    parentId: rootFolderId,
    currentVersion: {
      id: toSafeId<"entityVersion">("version_nested"),
      fields: [],
    },
  },
];

const createContext = ({
  body = { entityId: rootFolderId },
  safeDb,
}: {
  body?: Parameters<typeof duplicateEntity.handler>[0]["body"];
  safeDb: Parameters<typeof duplicateEntity.handler>[0]["safeDb"];
}): Parameters<typeof duplicateEntity.handler>[0] => {
  const recorderBindings = {
    organizationId,
    workspaceId,
    userId,
    request: new Request("https://example.test/v1/entities/duplicate"),
    server: null,
  };

  return {
    workspaceId,
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
    memberRole: { role: "owner" },
    body,
    request: recorderBindings.request,
    route: "/v1/entities/:workspaceId/duplicate",
    safeDb,
    recordAuditEvent: createAuditRecorder(recorderBindings),
    createAuditRecorder: () => createAuditRecorder(recorderBindings),
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture only provides fields touched by the handler
  } as Parameters<typeof duplicateEntity.handler>[0];
};

describe("duplicate name collisions", () => {
  test("reserves room for the collision suffix and extension", async () => {
    const requestedName = `${"a".repeat(250)}.docx`;
    const firstCollisionName = `${"a".repeat(248)}_1.docx`;
    const tx = {
      select: () => ({
        from: () => ({
          where: async () => [
            { name: requestedName },
            { name: firstCollisionName },
          ],
        }),
      }),
    };

    const resolved = await resolveEntityName({
      tx: asTestRaw<Transaction>(tx),
      workspaceId,
      parentId: null,
      name: requestedName,
    });

    expect(resolved).toBe(`${"a".repeat(248)}_2.docx`);
    expect(resolved).toHaveLength(255);
  });

  test("detects collisions after truncating an oversized extension", async () => {
    const extension = `.${"x".repeat(253)}`;
    const requestedName = `a${extension}`;
    const boundedExtension = extension.slice(0, 253);
    const firstCollisionName = `_1${boundedExtension}`;
    const tx = {
      select: () => ({
        from: () => ({
          where: async () => [
            { name: requestedName },
            { name: firstCollisionName },
          ],
        }),
      }),
    };

    const resolved = await resolveEntityName({
      tx: asTestRaw<Transaction>(tx),
      workspaceId,
      parentId: null,
      name: requestedName,
    });

    expect(resolved).toBe(`_2${boundedExtension}`);
    expect(resolved).toHaveLength(255);
  });
});

describe("duplicate entity", () => {
  test("uses the requested identity and renames only the primary file", async () => {
    const insertedEntities: InsertedEntity[] = [];
    const insertedFields: InsertedField[] = [];

    const source = sourceEntities.at(1);
    if (!source) {
      throw new Error("Expected source document fixture");
    }
    const sourceDocument = {
      ...source,
      currentVersion: {
        ...source.currentVersion,
        fields: [
          { id: sourceFileFieldId, propertyId, content: fileContent },
          {
            id: secondaryFileFieldId,
            propertyId: secondaryPropertyId,
            content: secondaryFileContent,
          },
        ],
      },
    };
    let entityLookupCount = 0;
    const tx = {
      query: {
        entities: {
          findFirst: async () => {
            entityLookupCount++;
            return entityLookupCount === 1 ? sourceDocument : undefined;
          },
        },
        workspaces: { findFirst: async () => ({ reference: null }) },
      },
      $count: async () => 1,
      select: () => ({
        from: () => ({ where: async () => [{ name: sourceDocument.name }] }),
      }),
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === documentCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => [{ lastValue: 1 }],
              }),
            };
          }
          if (table === entities && Array.isArray(value)) {
            insertedEntities.push(...value.filter(isInsertedEntity));
          } else if (table === entityVersions) {
            return entityVersionInsertResult(value);
          } else if (table === fields && Array.isArray(value)) {
            insertedFields.push(...value.filter(isInsertedField));
          }
          return undefined;
        },
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };
    const { safeDb } = createScopedDbMock(tx);

    const result = await duplicateEntity.handler(
      createContext({
        body: {
          entityId: documentId,
          name: "Child (copy).docx",
          targetEntityId: requestedDuplicateId,
        },
        safeDb,
      }),
    );

    expect(result).toEqual({
      entityId: requestedDuplicateId,
      fieldId: expect.any(String),
      name: "Child (copy).docx",
    });
    expect(insertedEntities.at(0)?.name).toBe("Child (copy).docx");
    const primaryContent = insertedFields.at(0)?.content;
    expect(primaryContent?.type).toBe("file");
    if (primaryContent?.type === "file") {
      expect(primaryContent.fileName).toBe("Child (copy).docx");
    }
    const secondaryContent = insertedFields.at(1)?.content;
    expect(secondaryContent?.type).toBe("file");
    if (secondaryContent?.type === "file") {
      expect(secondaryContent.fileName).toBe("Schedule.xlsx");
    }
  });

  test("returns the committed target when the same request is replayed", async () => {
    const sourceDocument = sourceEntities.at(1);
    let entityLookupCount = 0;
    let replayQuery: unknown;
    const tx = {
      query: {
        entities: {
          findFirst: async (query: unknown) => {
            entityLookupCount++;
            if (entityLookupCount === 1) {
              return sourceDocument;
            }
            replayQuery = query;
            return {
              id: requestedDuplicateId,
              name: "Child (Copy).docx",
              currentVersion: {
                fields: [
                  {
                    id: toSafeId<"field">("existing_copy_field"),
                    content: fileContent,
                  },
                ],
              },
            };
          },
        },
        workspaces: { findFirst: async () => ({ reference: null }) },
      },
      $count: async () => 1,
      select: () => ({
        from: () => ({ where: async () => [{ name: sourceDocument?.name }] }),
      }),
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === documentCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => [{ lastValue: 1 }],
              }),
            };
          }
          if (table === entities) {
            throw new Error("duplicate key value violates primary key");
          }
          return table === entityVersions
            ? entityVersionInsertResult(value)
            : undefined;
        },
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };
    const { safeDb } = createScopedDbMock(tx);

    const result = await duplicateEntity.handler(
      createContext({
        body: {
          entityId: documentId,
          name: "Child (Copy).docx",
          targetEntityId: requestedDuplicateId,
        },
        safeDb,
      }),
    );

    expect(result).toEqual({
      entityId: requestedDuplicateId,
      fieldId: toSafeId<"field">("existing_copy_field"),
      name: "Child (Copy).docx",
    });
    expect(replayQuery).toMatchObject({
      with: {
        currentVersion: {
          with: { fields: { orderBy: { id: "asc" } } },
        },
      },
    });
    const copiedKeys = fake.requests
      .filter(({ method }) => method === "COPY")
      .map(({ key }) => key);
    expect(copiedKeys).toHaveLength(0);
    expect(
      fake.requests
        .filter(({ method }) => method === "DELETE")
        .map(({ key }) => key),
    ).toEqual([]);
  });

  test("retains copied objects when a lost commit acknowledgement replays", async () => {
    const sourceDocument = sourceEntities.at(1);
    let entityLookupCount = 0;
    const replayFieldId = toSafeId<"field">("committed_copy_field");
    const tx = {
      query: {
        entities: {
          findFirst: async () => {
            entityLookupCount++;
            if (entityLookupCount === 1) {
              return sourceDocument;
            }
            if (entityLookupCount === 2) {
              return undefined;
            }
            return {
              id: requestedDuplicateId,
              name: "Child (Copy).docx",
              currentVersion: {
                fields: [{ id: replayFieldId, content: fileContent }],
              },
            };
          },
        },
        workspaces: { findFirst: async () => ({ reference: null }) },
      },
      $count: async () => 1,
      select: () => ({
        from: () => ({ where: async () => [{ name: sourceDocument?.name }] }),
      }),
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === documentCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => [{ lastValue: 1 }],
              }),
            };
          }
          return table === entityVersions
            ? entityVersionInsertResult(value)
            : undefined;
        },
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };
    const { safeDb: committedSafeDb } = createScopedDbMock(tx);
    let safeDbCallCount = 0;
    const safeDb: SafeDb = async (callback, retry) => {
      safeDbCallCount++;
      const result = await committedSafeDb(callback, retry);
      if (safeDbCallCount === 3 && !Result.isError(result)) {
        return Result.err(
          new DatabaseError({ message: "commit acknowledgement lost" }),
        );
      }
      return result;
    };

    const result = await duplicateEntity.handler(
      createContext({
        body: {
          entityId: documentId,
          name: "Child (Copy).docx",
          targetEntityId: requestedDuplicateId,
        },
        safeDb,
      }),
    );

    expect(result).toEqual({
      entityId: requestedDuplicateId,
      fieldId: replayFieldId,
      name: "Child (Copy).docx",
    });
    expect(
      fake.requests.filter(({ method }) => method === "COPY"),
    ).toHaveLength(1);
    expect(fake.requests.filter(({ method }) => method === "DELETE")).toEqual(
      [],
    );
  });

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
            if (!Array.isArray(value) || !value.every(isInsertedEntity)) {
              throw new TypeError("Invalid inserted entity fixture value");
            }
            insertedEntities.push(...value);
          } else if (table === entityVersions) {
            if (!Array.isArray(value)) {
              throw new TypeError("Invalid inserted version fixture value");
            }
            insertedVersions.push(...value);
            return entityVersionInsertResult(value);
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
      fieldId: null,
      name: "Root_1",
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

    // The nested folder is the third entity in copy order: the document's
    // object is already copied when the copy rejects it.
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
        values: (value: unknown) => {
          if (table === documentCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => [{ lastValue: 1 }],
              }),
            };
          }
          return table === entityVersions
            ? entityVersionInsertResult(value)
            : undefined;
        },
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
    // The store is back to the original source objects alone.
    expect(new Set(fake.objects.keys())).toEqual(
      new Set([
        `${envBase.S3_BUCKET}/${sourceKey}`,
        `${envBase.S3_BUCKET}/${secondarySourceKey}`,
      ]),
    );

    // Nothing is indexed for copies that no longer exist.
    expect(enqueueEntitySearchRepairsMock).not.toHaveBeenCalled();
    expect(flushEntitySearchRepairsMock).not.toHaveBeenCalled();
    expect(enqueueDocumentProcessingRunMock).not.toHaveBeenCalled();
  });
});
