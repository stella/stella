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

const processExtractionMock = mock(async () => {});

void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
}));

const fileMock = mock(() => ({}));
const writeMock = mock(async () => undefined);
const s3DeleteMock = mock(async () => undefined);

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({ delete: s3DeleteMock, file: fileMock, write: writeMock }),
}));

const { default: duplicateEntity } = await import("./duplicate");

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
    expect(writeMock).toHaveBeenCalledTimes(1);

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
    expect(processExtractionMock).toHaveBeenCalledTimes(3);
  });
});
