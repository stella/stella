import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { documentCounters, entities, fields } from "@/api/db/schema";
import type { FieldContent, PropertyContent } from "@/api/db/schema-validators";
import { envBase } from "@/api/env-base";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import { DOCUMENT_TYPE_CLASSIFIER_ROLE } from "@/api/lib/properties/create-schema";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

// Every copy is a real server-side copy inside a real store, so the keys the
// copy wrote and the keys a rollback returned are read back from it.
const fileBytes = new TextEncoder().encode("file content");

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
const realFileDerivativeQueue = await import("@/api/lib/file-derivative-queue");
void mock.module("@/api/lib/file-derivative-queue", () => ({
  ...realFileDerivativeQueue,
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

const sourceFileId = "file-uuid-1";
const sourceFileMimeType = "application/pdf";

const fileContent: FieldContent = {
  type: "file",
  version: 1,
  id: sourceFileId,
  fileName: "Document.pdf",
  mimeType: sourceFileMimeType,
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

let fake: FakeS3;

const sourceObjectKey = (fileId: string, mimeType: string): string =>
  createFileKey({
    organizationId,
    workspaceId: sourceWorkspaceId,
    fileId,
    mimeType,
  });

const seedSourceObject = (fileId: string, mimeType: string): string => {
  const key = sourceObjectKey(fileId, mimeType);
  fake.put(envBase.S3_BUCKET, key, fileBytes, mimeType);
  return key;
};

const objectKeysInStore = (): string[] => [...fake.objects.keys()];

const requestKeys = (method: "COPY" | "DELETE" | "GET"): string[] =>
  fake.requests
    .filter((request) => request.method === method)
    .map(({ key }) => key);

let analytics: RecordingAnalytics;

afterEach(() => {
  analytics.restore();
  fake.stop();
});

beforeEach(() => {
  analytics = installRecordingAnalytics();
  fake = startFakeS3();
  seedSourceObject(sourceFileId, sourceFileMimeType);
  requestNativeExtractionRunsMock.mockClear();
  enqueueDocumentProcessingRunMock.mockClear();
  enqueueEntitySearchRepairsMock.mockClear();
  flushEntitySearchRepairsMock.mockClear();
  syncWorkspaceSearchActivityMock.mockClear();
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
  targetWorkspace,
}: {
  safeDb: CopyToWorkspaceContext["safeDb"];
  entityId: SafeId<"entity">;
  targetWorkspaceId?: SafeId<"workspace">;
  targetParentId?: SafeId<"entity"> | null;
  deleteSource?: boolean;
  targetWorkspace?: AccessibleWorkspace | null;
}): CopyToWorkspaceContext => {
  const resolvedTargetWorkspace =
    targetWorkspace === undefined
      ? { id: targetWorkspaceIdArg, status: "active" as const }
      : targetWorkspace;
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
    getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) =>
      workspaceId === targetWorkspaceIdArg ? resolvedTargetWorkspace : null,
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

    // The copy owns its own object in the target workspace, and the field
    // points at it: the key derived from the persisted file id holds the
    // source bytes.
    if (copiedField?.content.type !== "file") {
      throw new Error("Expected the copied field to be a file field");
    }
    const copiedKey = createFileKey({
      organizationId,
      workspaceId: targetWorkspaceId,
      fileId: copiedField.content.id,
      mimeType: copiedField.content.mimeType,
    });
    expect(fake.objects.get(`${envBase.S3_BUCKET}/${copiedKey}`)).toEqual({
      bytes: fileBytes,
      contentType: sourceFileMimeType,
    });
    // The bytes never travel through the API task.
    expect(requestKeys("GET")).toEqual([]);

    // The extraction run that reads the copied PDF indexes it, so the copy
    // carries no mark of its own; marking it too would index it twice.
    if (!copiedEntity) {
      throw new Error("Expected the copy to be inserted");
    }
    expect(requestNativeExtractionRunsMock).toHaveBeenCalledTimes(1);
    expect(enqueueDocumentProcessingRunMock.mock.calls).toEqual([
      [toSafeId<"documentProcessingRun">("run_0")],
    ]);
    expect(enqueueEntitySearchRepairsMock.mock.calls.at(0)?.at(1)).toEqual([]);
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
    expect(requestKeys("GET")).toEqual([]);
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
    expect(requestKeys("GET")).toEqual([]);
    expect(requestKeys("COPY")).toEqual([]);
    // The source object is still the only one in the store.
    expect(objectKeysInStore()).toEqual([
      `${envBase.S3_BUCKET}/${sourceObjectKey(sourceFileId, sourceFileMimeType)}`,
    ]);
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
    const movedKeys = requestKeys("COPY");
    expect(movedKeys).toHaveLength(1);
    // The move succeeded, so the copy stays: a failed source-cleanup lookup
    // must not take the object the target workspace now owns.
    expect(requestKeys("DELETE")).toEqual([]);
    expect(fake.objects.has(`${envBase.S3_BUCKET}/${movedKeys.at(0)}`)).toBe(
      true,
    );
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        // `safeDb` wraps a throwing query, so the reported defect is the
        // wrapper and the raw failure rides along as its cause.
        "error.class": "UnhandledException",
        "error.cause.class": "Error",
        operation: "move-cleanup",
        sourceEntityId: documentId,
        sourceWorkspaceId,
      },
    ]);
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

    // Neither copy has a file for an extraction run to read, so both are
    // marked dirty inside the copy transaction and nothing else would index
    // them if the post-commit flush were lost.
    expect(enqueueDocumentProcessingRunMock).not.toHaveBeenCalled();
    expect(enqueueEntitySearchRepairsMock).toHaveBeenCalledTimes(1);
    expect(enqueueEntitySearchRepairsMock.mock.calls.at(0)?.at(1)).toEqual([
      copiedFolder?.id,
      copiedChild?.id,
    ]);
    expect(flushEntitySearchRepairsMock).toHaveBeenCalledTimes(1);
  });

  test("remaps file IDs in field content for S3 copy", async () => {
    const insertedFields: InsertedField[] = [];
    let nextDocumentSequence = 0;

    const originalFileId = "original-file-uuid";
    seedSourceObject(originalFileId, "image/png");
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

  test("returns every object copied for an aborted cross-matter copy", async () => {
    const insertedEntities: InsertedEntity[] = [];
    const sourceEntity = {
      id: documentId,
      kind: "document" as const,
      name: "Doc.pdf",
      parentId: null,
      readOnly: false,
      currentVersion: {
        id: toSafeId<"entityVersion">("v1"),
        fields: [{ propertyId: sourceFilePropertyId, content: fileContent }],
      },
    };

    // The handler reads the source first; the copy then reads the target
    // parent, which turns out to be a document rather than a folder.
    let entityReadCount = 0;
    const tx = {
      query: {
        entities: {
          findFirst: async () => {
            entityReadCount += 1;
            return entityReadCount === 1
              ? sourceEntity
              : { kind: "document" as const };
          },
          findMany: async () => [sourceEntity],
        },
        properties: {
          findMany: async (opts: {
            where: { workspaceId: { eq: string } };
          }) => [
            {
              id:
                opts.where.workspaceId.eq === sourceWorkspaceId
                  ? sourceFilePropertyId
                  : targetFilePropertyId,
              name: "Source File",
              content: filePropertyContent,
              system: true,
            },
          ],
        },
        workspaces: { findFirst: async () => ({ reference: null }) },
      },
      $count: async () => 0,
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === entities && isInsertedEntity(value)) {
            insertedEntities.push(value);
          }
          return undefined;
        },
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };

    const { safeDb } = createScopedDbMock(tx);
    const result = await copyToWorkspace.handler(
      createContext({
        safeDb,
        entityId: documentId,
        targetParentId: folderId,
      }),
    );

    // The abort travels as the same rejection the caller always answered.
    expect(result).toMatchObject({
      code: 400,
      response: { message: "Target parent must be a folder" },
    });
    expect(insertedEntities).toHaveLength(0);

    // No row survives the abort, so every object copied for it is an orphan
    // and all of them go back.
    const copiedKeys = requestKeys("COPY");
    const deletedKeys = requestKeys("DELETE");
    expect(copiedKeys).toHaveLength(1);
    expect(new Set(deletedKeys)).toEqual(new Set(copiedKeys));
    // The store is back to the source object alone.
    expect(objectKeysInStore()).toEqual([
      `${envBase.S3_BUCKET}/${sourceObjectKey(sourceFileId, sourceFileMimeType)}`,
    ]);

    // Nothing is indexed for copies that no longer exist.
    expect(enqueueEntitySearchRepairsMock).not.toHaveBeenCalled();
    expect(flushEntitySearchRepairsMock).not.toHaveBeenCalled();
    expect(enqueueDocumentProcessingRunMock).not.toHaveBeenCalled();
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
    });

    const result = await copyToWorkspace.handler(context);

    expect(result).toMatchObject({
      response: {
        message: "Cannot copy to the same workspace; use duplicate instead",
      },
    });
  });
});
