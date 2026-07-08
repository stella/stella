import { beforeEach, describe, expect, mock, test } from "bun:test";

import { auditLogs, documentCounters, entities, fields } from "@/api/db/schema";
import type { FieldContent, PropertyContent } from "@/api/db/schema-validators";
import { DOCUMENT_TYPE_CLASSIFIER_ROLE } from "@/api/handlers/properties/create-schema";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

// S3 mocks
const fileBytes = new TextEncoder().encode("file content");
const arrayBufferMock = mock(async () =>
  fileBytes.buffer.slice(
    fileBytes.byteOffset,
    fileBytes.byteOffset + fileBytes.byteLength,
  ),
);
const fileMock = mock(() => ({ arrayBuffer: arrayBufferMock }));
const writeMock = mock(async () => undefined);
const s3DeleteMock = mock(async () => undefined);

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({ delete: s3DeleteMock, file: fileMock, write: writeMock }),
}));

const processExtractionMock = mock(async () => {});
void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
}));

const captureErrorMock = mock(() => undefined);
void mock.module("@/api/lib/analytics", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: () => ({ capture: mock(() => undefined) }),
  isLocalPostHogDebugEnabled: () => false,
}));

const broadcastQueryInvalidationToTargetWorkspaceMock = mock(() => undefined);
void mock.module("@/api/lib/invalidate-query-macro", () => ({
  broadcastQueryInvalidationToOrganization: mock(() => undefined),
  broadcastQueryInvalidationToTargetWorkspace:
    broadcastQueryInvalidationToTargetWorkspaceMock,
}));

const syncWorkspaceSearchActivityMock = mock(async () => {});
void mock.module("@/api/lib/search/index-global", () => ({
  rebuildSupplementalSearchIndex: mock(async () => undefined),
  reindexWorkspacesForContact: mock(async () => undefined),
  searchGlobal: mock(async () => ({
    facets: { editor: [], mimeType: [], type: [], workspace: [] },
    hits: [],
    nextCursor: null,
    totalCount: 0,
  })),
  searchGlobalFacet: mock(async () => []),
  syncWorkspaceSearchActivity: syncWorkspaceSearchActivityMock,
  upsertContactSearchDocument: mock(async () => undefined),
  upsertWorkspaceSearchDocument: mock(async () => undefined),
  upsertWorkspaceSearchDocuments: mock(async () => undefined),
}));

const enqueueImageThumbnailOrMarkFailedMock = mock(async () => undefined);
const enqueueImageThumbnailMock = mock(async () => undefined);
const enqueuePdfDerivativeMock = mock(async () => undefined);
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => undefined);
void mock.module("@/api/lib/file-derivative-queue", () => ({
  enqueueImageThumbnail: enqueueImageThumbnailMock,
  enqueueImageThumbnailOrMarkFailed: enqueueImageThumbnailOrMarkFailedMock,
  enqueuePdfDerivative: enqueuePdfDerivativeMock,
  enqueuePdfDerivativeOrMarkFailed: enqueuePdfDerivativeOrMarkFailedMock,
  initFileDerivativeWorker: mock(() => undefined),
}));

const { default: copyToWorkspace } = await import("./copy-to-workspace");

const sourceWorkspaceId = toSafeId<"workspace">("source_workspace");
const targetWorkspaceId = toSafeId<"workspace">("target_workspace");
const organizationId = toSafeId<"organization">("organization_1");
const userId = toSafeId<"user">("user_1");

const documentId = toSafeId<"entity">("document_1");
const folderId = toSafeId<"entity">("folder_1");
const childDocId = toSafeId<"entity">("child_doc");

// Properties in source workspace
const sourceFilePropertyId = toSafeId<"property">("source_file_prop");
const sourceCustomPropertyId = toSafeId<"property">("source_custom_prop");
const sourceClassifierPropertyId = toSafeId<"property">(
  "source_classifier_prop",
);
const sourceDuplicateClassifierPropertyId = toSafeId<"property">(
  "source_duplicate_classifier_prop",
);

// Matching property in target workspace (same name+type as sourceFilePropertyId)
const targetFilePropertyId = toSafeId<"property">("target_file_prop");
const targetClassifierPropertyId = toSafeId<"property">(
  "target_classifier_prop",
);

const filePropertyContent: PropertyContent = { version: 1, type: "file" };
const textPropertyContent: PropertyContent = { version: 1, type: "text" };

const fileContent: FieldContent = {
  type: "file",
  version: 1,
  id: "file-uuid-1",
  fileName: "Document.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
};

const textFieldContent: FieldContent = {
  type: "text",
  version: 1,
  value: "Custom value",
};

const classifierPropertyContent: PropertyContent = {
  version: 1,
  type: "single-select",
  options: [{ value: "NDA", color: "blue" }],
  fallback: null,
};

const classifierFieldContent: FieldContent = {
  type: "single-select",
  version: 1,
  value: "NDA",
};

type InsertedEntity = {
  id: SafeId<"entity">;
  kind: string;
  name: string | null;
  parentId: SafeId<"entity"> | null;
  docSequence?: number | null;
};

type InsertedField = {
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
  entityVersionId: SafeId<"entityVersion">;
  content: FieldContent;
};

type CopyToWorkspaceContext = Parameters<typeof copyToWorkspace.handler>[0];

const isInsertedEntity = (value: unknown): value is InsertedEntity =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  "kind" in value &&
  "name" in value &&
  "parentId" in value;

const isInsertedField = (value: unknown): value is InsertedField =>
  typeof value === "object" &&
  value !== null &&
  "workspaceId" in value &&
  "propertyId" in value &&
  "content" in value;

beforeEach(() => {
  arrayBufferMock.mockClear();
  fileMock.mockClear();
  writeMock.mockClear();
  s3DeleteMock.mockClear();
  captureErrorMock.mockClear();
  processExtractionMock.mockClear();
  syncWorkspaceSearchActivityMock.mockClear();
  broadcastQueryInvalidationToTargetWorkspaceMock.mockClear();
  enqueueImageThumbnailMock.mockClear();
  enqueueImageThumbnailOrMarkFailedMock.mockClear();
  enqueuePdfDerivativeMock.mockClear();
  enqueuePdfDerivativeOrMarkFailedMock.mockClear();
});

const createContext = ({
  safeDb,
  entityId,
  targetWorkspaceId: targetWorkspaceIdArg = targetWorkspaceId,
  targetParentId = null,
  deleteSource = false,
  accessibleWorkspaces,
}: {
  safeDb: CopyToWorkspaceContext["safeDb"];
  entityId: SafeId<"entity">;
  targetWorkspaceId?: SafeId<"workspace">;
  targetParentId?: SafeId<"entity"> | null;
  deleteSource?: boolean;
  accessibleWorkspaces?: CopyToWorkspaceContext["accessibleWorkspaces"];
}): CopyToWorkspaceContext => {
  const sourceRecorderBindings = {
    organizationId,
    workspaceId: sourceWorkspaceId,
    userId,
    request: new Request("https://example.test/v1/entities/copy-to-workspace"),
    server: null,
  };
  const createBoundAuditRecorder: CopyToWorkspaceContext["createAuditRecorder"] =
    (opts) =>
      createAuditRecorder({
        ...sourceRecorderBindings,
        workspaceId:
          opts && "workspaceId" in opts
            ? (opts.workspaceId ?? null)
            : sourceWorkspaceId,
      });

  const context = asTestRaw<CopyToWorkspaceContext>({
    workspaceId: sourceWorkspaceId,
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
    memberRole: { role: "owner" },
    body: {
      entityId,
      targetWorkspaceId: targetWorkspaceIdArg,
      targetParentId,
      deleteSource,
    },
    request: sourceRecorderBindings.request,
    route: "/v1/workspaces/:workspaceId/entities/copy-to-workspace",
    accessibleWorkspaces: accessibleWorkspaces ?? [
      { id: sourceWorkspaceId, status: "active" },
      { id: targetWorkspaceIdArg, status: "active" },
    ],
    safeDb,
    recordAuditEvent: createAuditRecorder(sourceRecorderBindings),
    createAuditRecorder: createBoundAuditRecorder,
  });

  return context;
};

describe("copy-to-workspace", () => {
  test("copies document with matching property, skips non-matching property", async () => {
    const insertedEntities: InsertedEntity[] = [];
    const insertedFields: InsertedField[] = [];
    const insertedAuditLogs: unknown[] = [];
    let nextDocumentSequence = 0;

    // Source entity has two fields: one file (matches target), one text (no match)
    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Report.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("version_1"),
        fields: [
          { propertyId: sourceFilePropertyId, content: fileContent },
          { propertyId: sourceCustomPropertyId, content: textFieldContent },
        ],
      },
    };

    // Source properties
    const sourceProperties = [
      {
        id: sourceFilePropertyId,
        name: "Source File",
        content: filePropertyContent,
        system: true,
      },
      {
        id: sourceCustomPropertyId,
        name: "Custom Field",
        content: textPropertyContent,
        system: false,
      },
    ];

    // Target properties - only has "Source File" (file type), no "Custom Field"
    const targetProperties = [
      {
        id: targetFilePropertyId,
        name: "Source File",
        content: filePropertyContent,
        system: true,
      },
    ];

    const tx = {
      query: {
        entities: {
          findFirst: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return sourceEntity;
            }
            return undefined;
          },
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return sourceProperties;
            }
            if (opts.where.workspaceId.eq === targetWorkspaceId) {
              return targetProperties;
            }
            return [];
          },
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 1,
      select: () => ({
        from: () => ({
          where: async () => [],
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

          if (table === entities && isInsertedEntity(value)) {
            insertedEntities.push(value);
          } else if (table === fields) {
            if (Array.isArray(value)) {
              for (const v of value) {
                if (isInsertedField(v)) {
                  insertedFields.push(v);
                }
              }
            } else if (isInsertedField(value)) {
              insertedFields.push(value);
            }
          } else if (table === auditLogs) {
            insertedAuditLogs.push(value);
          }

          return undefined;
        },
      }),
      update: (_table: unknown) => ({
        set: () => ({
          where: async () => {},
        }),
      }),
      delete: () => ({
        where: async () => {},
      }),
    };

    const { safeDb } = createScopedDbMock(tx);
    const result = await copyToWorkspace.handler(
      createContext({ safeDb, entityId: documentId }),
    );

    expect(result).toEqual({
      entityId: expect.any(String),
      entityIds: expect.any(Array),
    });

    // One entity inserted
    expect(insertedEntities).toHaveLength(1);
    const copiedEntity = insertedEntities.at(0);
    expect(copiedEntity?.kind).toBe("document");
    // Name preserved since no conflict exists in target workspace
    expect(copiedEntity?.name).toBe("Report.pdf");

    // Only ONE field inserted (the file field that matched)
    // The text field should be skipped because "Custom Field" doesn't exist in target
    expect(insertedFields).toHaveLength(1);
    const copiedField = insertedFields.at(0);
    expect(copiedField?.propertyId).toBe(targetFilePropertyId);
    expect(copiedField?.content.type).toBe("file");

    // S3 file was copied
    expect(fileMock).toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalled();
  });

  test("maps document type classifier fields by role before name fallback", async () => {
    const insertedFields: InsertedField[] = [];
    let nextDocumentSequence = 0;
    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Localized.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("version_1"),
        fields: [
          {
            propertyId: sourceClassifierPropertyId,
            content: classifierFieldContent,
          },
        ],
      },
    };
    const sourceProperties = [
      {
        id: sourceClassifierPropertyId,
        name: "Document Type",
        content: classifierPropertyContent,
        system: false,
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      },
    ];
    const targetProperties = [
      {
        id: targetFilePropertyId,
        name: "Documents",
        content: filePropertyContent,
        system: true,
        role: null,
      },
      {
        id: targetClassifierPropertyId,
        name: "Type de document",
        content: classifierPropertyContent,
        system: false,
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      },
    ];
    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceEntity,
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return sourceProperties;
            }
            if (opts.where.workspaceId.eq === targetWorkspaceId) {
              return targetProperties;
            }
            return [];
          },
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: async () => [],
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
          if (table === fields && Array.isArray(value)) {
            for (const row of value) {
              if (isInsertedField(row)) {
                insertedFields.push(row);
              }
            }
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
    const result = await copyToWorkspace.handler(
      createContext({ safeDb, entityId: documentId }),
    );

    expect(result).toEqual({
      entityId: expect.any(String),
      entityIds: expect.any(Array),
    });
    expect(insertedFields).toHaveLength(1);
    expect(insertedFields.at(0)?.propertyId).toBe(targetClassifierPropertyId);
    expect(insertedFields.at(0)?.content).toEqual(classifierFieldContent);
    expect(fileMock).not.toHaveBeenCalled();
  });

  test("maps legacy classifier fields before backfill has tagged either side", async () => {
    const insertedFields: InsertedField[] = [];
    let nextDocumentSequence = 0;
    const classifierTool = {
      version: 1,
      type: "ai-model",
      prompt: "Classify the document type.",
    } as const;
    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Legacy.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("version_1"),
        fields: [
          {
            propertyId: sourceClassifierPropertyId,
            content: classifierFieldContent,
          },
        ],
      },
    };
    const sourceProperties = [
      {
        id: sourceClassifierPropertyId,
        name: "Document Type",
        content: classifierPropertyContent,
        system: false,
        role: null,
        tool: classifierTool,
      },
    ];
    const targetProperties = [
      {
        id: targetFilePropertyId,
        name: "Documents",
        content: filePropertyContent,
        system: true,
        role: null,
        tool: { version: 1, type: "manual-input" } as const,
      },
      {
        id: targetClassifierPropertyId,
        name: "Document Type",
        content: classifierPropertyContent,
        system: false,
        role: null,
        tool: classifierTool,
      },
    ];
    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceEntity,
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return sourceProperties;
            }
            if (opts.where.workspaceId.eq === targetWorkspaceId) {
              return targetProperties;
            }
            return [];
          },
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: async () => [],
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
          if (table === fields && Array.isArray(value)) {
            for (const row of value) {
              if (isInsertedField(row)) {
                insertedFields.push(row);
              }
            }
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
    const result = await copyToWorkspace.handler(
      createContext({ safeDb, entityId: documentId }),
    );

    expect(result).toEqual({
      entityId: expect.any(String),
      entityIds: expect.any(Array),
    });
    expect(insertedFields).toHaveLength(1);
    expect(insertedFields.at(0)?.propertyId).toBe(targetClassifierPropertyId);
    expect(insertedFields.at(0)?.content).toEqual(classifierFieldContent);
  });

  test("does not map classifier fields to unrelated target AI selects", async () => {
    const insertedFields: InsertedField[] = [];
    let nextDocumentSequence = 0;
    const classifierTool = {
      version: 1,
      type: "ai-model",
      prompt: "Classify the document type.",
    } as const;
    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Legacy.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("version_1"),
        fields: [
          {
            propertyId: sourceClassifierPropertyId,
            content: classifierFieldContent,
          },
        ],
      },
    };
    const sourceProperties = [
      {
        id: sourceClassifierPropertyId,
        name: "Document Type",
        content: classifierPropertyContent,
        system: false,
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
        tool: classifierTool,
      },
    ];
    const targetProperties = [
      {
        id: targetFilePropertyId,
        name: "Documents",
        content: filePropertyContent,
        system: true,
        role: null,
        tool: { version: 1, type: "manual-input" } as const,
      },
      {
        id: targetClassifierPropertyId,
        name: "Status",
        content: classifierPropertyContent,
        system: false,
        role: null,
        tool: classifierTool,
      },
    ];
    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceEntity,
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return sourceProperties;
            }
            if (opts.where.workspaceId.eq === targetWorkspaceId) {
              return targetProperties;
            }
            return [];
          },
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: async () => [],
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
          if (table === fields && Array.isArray(value)) {
            for (const row of value) {
              if (isInsertedField(row)) {
                insertedFields.push(row);
              }
            }
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
    const result = await copyToWorkspace.handler(
      createContext({ safeDb, entityId: documentId }),
    );

    expect(result).toEqual({
      entityId: expect.any(String),
      entityIds: expect.any(Array),
    });
    expect(insertedFields).toHaveLength(0);
  });

  test("does not remap roleless source classifier duplicates", async () => {
    const insertedFields: InsertedField[] = [];
    let nextDocumentSequence = 0;
    const classifierTool = {
      version: 1,
      type: "ai-model",
      prompt: "Classify the document type.",
    } as const;
    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Legacy duplicate.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("version_1"),
        fields: [
          {
            propertyId: sourceDuplicateClassifierPropertyId,
            content: classifierFieldContent,
          },
        ],
      },
    };
    const sourceProperties = [
      {
        id: sourceClassifierPropertyId,
        name: "Type de document",
        content: classifierPropertyContent,
        system: false,
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
        tool: classifierTool,
      },
      {
        id: sourceDuplicateClassifierPropertyId,
        name: "Document Type",
        content: classifierPropertyContent,
        system: false,
        role: null,
        tool: classifierTool,
      },
    ];
    const targetProperties = [
      {
        id: targetFilePropertyId,
        name: "Documents",
        content: filePropertyContent,
        system: true,
        role: null,
        tool: { version: 1, type: "manual-input" } as const,
      },
      {
        id: targetClassifierPropertyId,
        name: "Type de document",
        content: classifierPropertyContent,
        system: false,
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
        tool: classifierTool,
      },
    ];
    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceEntity,
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return sourceProperties;
            }
            if (opts.where.workspaceId.eq === targetWorkspaceId) {
              return targetProperties;
            }
            return [];
          },
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: async () => [],
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
          if (table === fields && Array.isArray(value)) {
            for (const row of value) {
              if (isInsertedField(row)) {
                insertedFields.push(row);
              }
            }
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
    const result = await copyToWorkspace.handler(
      createContext({ safeDb, entityId: documentId }),
    );

    expect(result).toEqual({
      entityId: expect.any(String),
      entityIds: expect.any(Array),
    });
    expect(insertedFields).toHaveLength(0);
  });

  test("drops tagged classifier fields when the target has no classifier", async () => {
    const insertedFields: InsertedField[] = [];
    let nextDocumentSequence = 0;
    const classifierTool = {
      version: 1,
      type: "ai-model",
      prompt: "Classify the document type.",
    } as const;
    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Classified.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("version_1"),
        fields: [
          {
            propertyId: sourceClassifierPropertyId,
            content: classifierFieldContent,
          },
        ],
      },
    };
    const sourceProperties = [
      {
        id: sourceClassifierPropertyId,
        name: "Type de document",
        content: classifierPropertyContent,
        system: false,
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
        tool: classifierTool,
      },
    ];
    const targetProperties = [
      {
        id: targetFilePropertyId,
        name: "Documents",
        content: filePropertyContent,
        system: true,
        role: null,
        tool: { version: 1, type: "manual-input" } as const,
      },
      {
        id: targetClassifierPropertyId,
        name: "Type de document",
        content: classifierPropertyContent,
        system: false,
        role: null,
        tool: { version: 1, type: "manual-input" } as const,
      },
    ];
    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceEntity,
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return sourceProperties;
            }
            if (opts.where.workspaceId.eq === targetWorkspaceId) {
              return targetProperties;
            }
            return [];
          },
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: async () => [],
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
          if (table === fields && Array.isArray(value)) {
            for (const row of value) {
              if (isInsertedField(row)) {
                insertedFields.push(row);
              }
            }
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
    const result = await copyToWorkspace.handler(
      createContext({ safeDb, entityId: documentId }),
    );

    expect(result).toEqual({
      entityId: expect.any(String),
      entityIds: expect.any(Array),
    });
    expect(insertedFields).toHaveLength(0);
  });

  test("does not copy files for fields without a target property", async () => {
    const insertedFields: InsertedField[] = [];
    let nextDocumentSequence = 0;

    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Orphan-prone.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("version_1"),
        fields: [{ propertyId: sourceFilePropertyId, content: fileContent }],
      },
    };

    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceEntity,
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return [
                {
                  id: sourceFilePropertyId,
                  name: "Source File",
                  content: filePropertyContent,
                  system: true,
                },
              ];
            }
            return [];
          },
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: async () => [],
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

          if (table === fields && Array.isArray(value)) {
            for (const v of value) {
              if (isInsertedField(v)) {
                insertedFields.push(v);
              }
            }
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
    await copyToWorkspace.handler(
      createContext({ safeDb, entityId: documentId }),
    );

    expect(insertedFields).toHaveLength(0);
    expect(fileMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("keeps move success when source file cleanup lookup fails", async () => {
    let nextDocumentSequence = 0;
    let selectCallCount = 0;
    let deletedEntityCount = 0;

    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Move.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("version_1"),
        fields: [{ propertyId: sourceFilePropertyId, content: fileContent }],
      },
    };

    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceEntity,
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return [
                {
                  id: sourceFilePropertyId,
                  name: "Source File",
                  content: filePropertyContent,
                  system: true,
                },
              ];
            }
            return [
              {
                id: targetFilePropertyId,
                name: "Source File",
                content: filePropertyContent,
                system: true,
              },
            ];
          },
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => {
        selectCallCount += 1;

        return {
          from: () => ({
            innerJoin: () => ({
              where: async () => {
                throw new Error("cleanup lookup failed");
              },
            }),
            where: async () => {
              if (selectCallCount === 1) {
                return [];
              }
              throw new Error("unexpected lookup");
            },
          }),
        };
      },
      insert: (table: unknown) => ({
        values: () => {
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

          return undefined;
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => {},
        }),
      }),
      delete: () => ({
        where: async () => {
          deletedEntityCount += 1;
        },
      }),
    };

    const { safeDb } = createScopedDbMock(tx);
    const result = await copyToWorkspace.handler(
      createContext({
        safeDb,
        entityId: documentId,
        deleteSource: true,
      }),
    );

    expect(result).toEqual({
      entityId: expect.any(String),
      entityIds: expect.any(Array),
    });
    expect(deletedEntityCount).toBe(1);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(s3DeleteMock).not.toHaveBeenCalled();
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("copies folder tree with children", async () => {
    const insertedEntities: InsertedEntity[] = [];
    let nextDocumentSequence = 0;

    const folderEntity = {
      id: folderId,
      kind: "folder" as const,
      name: "My Folder",
      parentId: null,
      readOnly: false,
      currentVersion: { id: toSafeId<"entityVersion">("v1"), fields: [] },
    };

    const childEntity = {
      id: childDocId,
      kind: "document" as const,
      name: "Child.pdf",
      parentId: folderId,
      currentVersion: { id: toSafeId<"entityVersion">("v2"), fields: [] },
    };

    const allEntities = [folderEntity, childEntity];

    const tx = {
      query: {
        entities: {
          findFirst: async () => folderEntity,
          findMany: async () => allEntities,
        },
        properties: {
          findMany: async () => [],
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: async () => [],
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

          if (table === entities && isInsertedEntity(value)) {
            insertedEntities.push(value);
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
    const result = await copyToWorkspace.handler(
      createContext({ safeDb, entityId: folderId }),
    );

    expect(result).toEqual({
      entityId: expect.any(String),
      entityIds: expect.any(Array),
    });

    // Both folder and child document inserted
    expect(insertedEntities).toHaveLength(2);

    const copiedFolder = insertedEntities.at(0);
    const copiedChild = insertedEntities.at(1);

    expect(copiedFolder?.kind).toBe("folder");
    // Name preserved since no conflict exists in target workspace
    expect(copiedFolder?.name).toBe("My Folder");
    expect(copiedFolder?.parentId).toBeNull();

    expect(copiedChild?.kind).toBe("document");
    expect(copiedChild?.name).toBe("Child.pdf");
    expect(copiedChild?.parentId).toBe(copiedFolder?.id);
  });

  test("remaps file IDs in field content for S3 copy", async () => {
    const insertedFields: InsertedField[] = [];
    let nextDocumentSequence = 0;

    const originalFileId = "original-file-uuid";
    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Doc.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("v1"),
        fields: [
          {
            propertyId: sourceFilePropertyId,
            content: {
              ...fileContent,
              id: originalFileId,
              mimeType: "image/png",
              placeholder: "data:image/png;base64,AAAA",
              thumbnailDerivative: { status: "ready" },
              thumbnailFileId: "original-thumbnail-uuid",
            },
          },
        ],
      },
    };

    const tx = {
      query: {
        entities: {
          findFirst: async () => sourceEntity,
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => {
            if (opts.where.workspaceId.eq === sourceWorkspaceId) {
              return [
                {
                  id: sourceFilePropertyId,
                  name: "Source File",
                  content: filePropertyContent,
                  system: true,
                },
              ];
            }
            return [
              {
                id: targetFilePropertyId,
                name: "Source File",
                content: filePropertyContent,
                system: true,
              },
            ];
          },
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: async () => [],
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

          if (table === fields && Array.isArray(value)) {
            for (const v of value) {
              if (isInsertedField(v)) {
                insertedFields.push(v);
              }
            }
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
    await copyToWorkspace.handler(
      createContext({ safeDb, entityId: documentId }),
    );

    expect(insertedFields).toHaveLength(1);
    const copiedField = insertedFields.at(0);

    // File ID should be remapped to a new UUID, not the original
    expect(copiedField?.content.type).toBe("file");
    if (copiedField?.content.type === "file") {
      expect(copiedField.content.id).not.toBe(originalFileId);
      expect(copiedField.content.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
      );
      expect(copiedField.content.thumbnailFileId).toBeNull();
      expect(copiedField.content.thumbnailDerivative).toEqual({
        status: "pending",
      });
      expect("placeholder" in copiedField.content).toBe(false);
    }
  });

  test("rejects copy to same workspace", async () => {
    const tx = {
      query: {
        entities: { findFirst: async () => undefined },
      },
    };

    const { safeDb } = createScopedDbMock(tx);

    const context = createContext({
      safeDb,
      entityId: documentId,
      targetWorkspaceId: sourceWorkspaceId,
      accessibleWorkspaces: [{ id: sourceWorkspaceId, status: "active" }],
    });

    const result = await copyToWorkspace.handler(context);

    expect(result).toMatchObject({
      response: {
        message: "Cannot copy to the same workspace; use duplicate instead",
      },
    });
  });
});
