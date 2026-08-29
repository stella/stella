import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { member } from "@/api/db/auth-schema";
import {
  auditLogs,
  documentCounters,
  entities,
  entityVersions,
  fields,
  matterCounters,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent, PropertyContent } from "@/api/db/schema-validators";
import { envBase } from "@/api/env-base";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { LIMITS } from "@/api/lib/limits";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDuplicateWorkspace } from "./duplicate";

const requestNativeExtractionRunsMock = mock(
  async ({ requests }: { requests: readonly unknown[] }) =>
    requests.map((_, index) =>
      toSafeId<"documentProcessingRun">(`run_${index}`),
    ),
);
const enqueueDocumentProcessingRunMock = mock(
  async (_runId: SafeId<"documentProcessingRun">) => undefined,
);
const enqueueWorkspaceSearchRepairsMock = mock(async () => undefined);
const enqueueEntitySearchRepairsMock = mock(
  async (_tx: unknown, _entityIds: readonly string[]) => undefined,
);
const flushEntitySearchRepairsMock = mock(async () => ({
  failed: 0,
  repaired: 0,
}));
const flushWorkspaceSearchRepairsMock = mock(async () => ({
  failed: 0,
  repaired: 0,
}));
const duplicateWorkspace = createDuplicateWorkspace({
  enqueueDocumentProcessingRun: enqueueDocumentProcessingRunMock,
  enqueueEntitySearchRepairs: enqueueEntitySearchRepairsMock,
  enqueueWorkspaceSearchRepairs: enqueueWorkspaceSearchRepairsMock,
  flushEntitySearchRepairs: flushEntitySearchRepairsMock,
  flushWorkspaceSearchRepairs: flushWorkspaceSearchRepairsMock,
  requestNativeExtractionRuns: requestNativeExtractionRunsMock,
});

type DuplicateWorkspaceCtx = Parameters<typeof duplicateWorkspace.handler>[0];
type InsertedWorkspaceField = {
  content: FieldContent;
  propertyId: SafeId<"property">;
};

const isInsertedWorkspaceField = (
  value: unknown,
): value is InsertedWorkspaceField =>
  typeof value === "object" &&
  value !== null &&
  "content" in value &&
  "propertyId" in value;

const isInsertedEntity = (
  value: unknown,
): value is { id: string; name: string } =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "name" in value &&
  typeof value.name === "string";

// Every file copy is a real server-side copy inside a real store, so the keys
// the duplicate wrote and the keys its cleanup returned are read back from it.
const sourceBytes = new TextEncoder().encode("evidence bytes");
const sourceOrganizationId = toSafeId<"organization">("org_test123");
const sourceWorkspaceId = toSafeId<"workspace">("ws_source123");

let fake: FakeS3;

const objectKey = (
  workspaceId: SafeId<"workspace">,
  fileId: string,
  mimeType: string,
): string =>
  `${envBase.S3_BUCKET}/${createFileKey({
    organizationId: sourceOrganizationId,
    workspaceId,
    fileId,
    mimeType,
  })}`;

const seedSourceObject = (fileId: string, mimeType: string): string => {
  const key = objectKey(sourceWorkspaceId, fileId, mimeType);
  fake.put(
    envBase.S3_BUCKET,
    key.slice(`${envBase.S3_BUCKET}/`.length),
    sourceBytes,
    mimeType,
  );
  return key;
};

const requestKeys = (method: "COPY" | "DELETE" | "GET"): string[] =>
  fake.requests
    .filter((request) => request.method === method)
    .map(({ key }) => key);

const readDuplicatedWorkspaceId = (result: unknown): SafeId<"workspace"> => {
  if (
    typeof result === "object" &&
    result !== null &&
    "workspaceId" in result &&
    typeof result.workspaceId === "string"
  ) {
    return toSafeId<"workspace">(result.workspaceId);
  }
  throw new Error("Expected the duplicate to return a workspace id");
};

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
});

const createContext = ({
  includeContent = false,
  safeDb,
  scopedDb,
}: {
  includeContent?: boolean;
  safeDb: DuplicateWorkspaceCtx["safeDb"];
  scopedDb: DuplicateWorkspaceCtx["scopedDb"];
}): DuplicateWorkspaceCtx => {
  const recorderBindings = {
    organizationId: toSafeId<"organization">("org_test123"),
    workspaceId: toSafeId<"workspace">("ws_source123"),
    userId: toSafeId<"user">("user_test123"),
    request: new Request(
      "https://api.example.test/v1/workspaces/ws_source123/duplicate",
    ),
    server: null,
  };

  return asTestRaw<DuplicateWorkspaceCtx>({
    body: { includeContent },
    safeDb,
    scopedDb,
    memberRole: { role: "owner" },
    orgAIConfig: null,
    request: recorderBindings.request,
    route: "/v1/workspaces/:workspaceId/duplicate",
    session: {
      activeOrganizationId: recorderBindings.organizationId,
    },
    user: { id: recorderBindings.userId },
    workspaceId: recorderBindings.workspaceId,
    recordAuditEvent: createAuditRecorder(recorderBindings),
    createAuditRecorder: () => createAuditRecorder(recorderBindings),
  });
};

describe("duplicateWorkspace", () => {
  test("copies the workspace lead when duplicating a matter", async () => {
    const insertedWorkspaces: unknown[] = [];
    const insertedWorkspaceMembers: unknown[] = [];
    const insertedAuditLogs: unknown[] = [];

    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        workspaces: {
          findFirst: async () => ({
            id: "ws_source123",
            name: "Smith v Jones",
            clientId: "contact_client123",
            billingReference: "BILL-123",
            color: "blue",
            leadUserId: "user_lead123",
          }),
        },
        properties: {
          findMany: async () => [],
        },
        propertyDependencies: {
          findMany: async () => [],
        },
        workspaceViews: {
          findMany: async () => [],
        },
        workspaceMembers: {
          findMany: async () => [{ userId: "user_lead123" }],
        },
        workspaceContacts: {
          findMany: async () => [],
        },
        organizationSettings: {
          findFirst: async () => null,
        },
      },
      select: (selectedFields: Record<string, unknown>) => {
        if ("total" in selectedFields) {
          return {
            from: () => ({
              where: async () => [{ total: 0 }],
            }),
          };
        }

        if ("name" in selectedFields) {
          return {
            from: () => ({
              where: async () => [],
            }),
          };
        }

        if ("userId" in selectedFields) {
          return {
            from: (table: unknown) => {
              expect(table).toBe(member);
              return {
                where: async () => [{ userId: "user_lead123" }],
              };
            },
          };
        }

        throw new Error("Unexpected select fields");
      },
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === matterCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => [{ lastValue: 1 }],
              }),
            };
          }

          if (table === workspaces) {
            insertedWorkspaces.push(value);
            return undefined;
          }

          if (table === workspaceMembers) {
            insertedWorkspaceMembers.push(value);
            return undefined;
          }

          if (table === auditLogs) {
            insertedAuditLogs.push(value);
            return undefined;
          }

          throw new Error("Unexpected insert table");
        },
      }),
      execute: async () => undefined,
    });

    const result = await duplicateWorkspace.handler(
      createContext({ safeDb, scopedDb }),
    );

    expect(result).toEqual({ workspaceId: expect.any(String) });
    expect(insertedWorkspaces).toEqual([
      expect.objectContaining({
        billingReference: "BILL-123",
        clientId: "contact_client123",
        color: "blue",
        leadUserId: "user_lead123",
        name: "Smith v Jones",
      }),
    ]);
    expect(insertedWorkspaceMembers).toEqual([
      [
        expect.objectContaining({
          userId: "user_lead123",
        }),
      ],
    ]);
    expect(insertedAuditLogs).toHaveLength(1);
  });

  test("preserves property roles when duplicating a matter", async () => {
    const insertedProperties: unknown[] = [];
    const propertyContent: PropertyContent = {
      type: "single-select",
      version: 1,
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    };

    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        workspaces: {
          findFirst: async () => ({
            id: "ws_source123",
            name: "Smith v Jones",
            clientId: null,
            billingReference: null,
            color: null,
            leadUserId: null,
          }),
        },
        properties: {
          findMany: async () => [
            {
              id: "prop_document_type",
              workspaceId: "ws_source123",
              name: "Type de document",
              status: "active",
              content: propertyContent,
              tool: {
                type: "ai-model",
                version: 1,
                prompt: "Classify the document type.",
              },
              system: false,
              kinds: ["document"],
              role: "document-type-classifier",
            },
          ],
        },
        propertyDependencies: {
          findMany: async () => [],
        },
        workspaceViews: {
          findMany: async () => [],
        },
        workspaceMembers: {
          findMany: async () => [],
        },
        workspaceContacts: {
          findMany: async () => [],
        },
        organizationSettings: {
          findFirst: async () => null,
        },
      },
      select: (selectedFields: Record<string, unknown>) => {
        if ("total" in selectedFields) {
          return {
            from: () => ({
              where: async () => [{ total: 0 }],
            }),
          };
        }

        if ("name" in selectedFields) {
          return {
            from: () => ({
              where: async () => [],
            }),
          };
        }

        throw new Error("Unexpected select fields");
      },
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === matterCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => [{ lastValue: 1 }],
              }),
            };
          }

          if (table === properties) {
            insertedProperties.push(value);
            return undefined;
          }

          if (table === auditLogs || table === workspaces) {
            return undefined;
          }

          throw new Error("Unexpected insert table");
        },
      }),
      execute: async () => undefined,
    });

    const result = await duplicateWorkspace.handler(
      createContext({ safeDb, scopedDb }),
    );

    expect(result).toEqual({ workspaceId: expect.any(String) });
    expect(insertedProperties).toEqual([
      [
        expect.objectContaining({
          name: "Type de document",
          role: "document-type-classifier",
        }),
      ],
    ]);
  });

  test("copies and remaps image thumbnail refs when duplicating content", async () => {
    requestNativeExtractionRunsMock.mockClear();
    enqueueDocumentProcessingRunMock.mockClear();
    enqueueWorkspaceSearchRepairsMock.mockClear();
    flushWorkspaceSearchRepairsMock.mockClear();

    const insertedFields: InsertedWorkspaceField[] = [];

    const filePropertyId = toSafeId<"property">("prop_file");
    const filePropertyContent: PropertyContent = { type: "file", version: 1 };
    const imageContent: FieldContent = {
      type: "file",
      version: 1,
      id: "source-file-id",
      fileName: "evidence.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      pdfFileId: "source-pdf-id",
      pdfDerivative: { status: "ready" },
      placeholder: "data:image/png;base64,AAAA",
      thumbnailDerivative: { status: "ready" },
      thumbnailFileId: "source-thumbnail-id",
    };
    const sourceKeys = [
      seedSourceObject(imageContent.id, imageContent.mimeType),
      seedSourceObject("source-pdf-id", PDF_MIME_TYPE),
      seedSourceObject("source-thumbnail-id", THUMBNAIL_MIME_TYPE),
    ];
    let nextMatterSequence = 0;

    const tx = {
      query: {
        workspaces: {
          findFirst: async () => ({
            id: "ws_source123",
            name: "Smith v Jones",
            clientId: null,
            billingReference: null,
            color: null,
            leadUserId: null,
          }),
        },
        properties: {
          findMany: async () => [
            {
              id: filePropertyId,
              workspaceId: "ws_source123",
              name: "Document",
              status: "active",
              content: filePropertyContent,
              tool: null,
              system: false,
              kinds: ["document"],
            },
          ],
        },
        propertyDependencies: {
          findMany: async () => [],
        },
        workspaceViews: {
          findMany: async () => [],
        },
        workspaceMembers: {
          findMany: async () => [],
        },
        workspaceContacts: {
          findMany: async () => [],
        },
        organizationSettings: {
          findFirst: async () => null,
        },
        entities: {
          findMany: async () => [
            {
              id: "entity_source",
              kind: "document",
              name: "evidence.png",
              parentId: null,
              status: "open",
              priority: null,
              dueDate: null,
              agendaKind: null,
              startAt: null,
              endAt: null,
              occurredAt: null,
              remindAt: null,
              allDay: null,
              timeZone: null,
              location: null,
              onlineMeetingUrl: null,
              availability: null,
              sensitivity: null,
              organizer: null,
              attendees: null,
              recurrence: null,
              agendaSource: null,
              sortOrder: null,
              metadata: null,
              currentVersion: {
                id: "version_source",
                fields: [{ propertyId: filePropertyId, content: imageContent }],
              },
            },
          ],
        },
      },
      select: (selectedFields: Record<string, unknown>) => {
        if ("total" in selectedFields) {
          return {
            from: () => ({
              where: async () => [{ total: 0 }],
            }),
          };
        }

        if ("name" in selectedFields) {
          return {
            from: () => ({
              where: async () => [],
            }),
          };
        }

        throw new Error("Unexpected select fields");
      },
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === documentCounters || table === matterCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => {
                  nextMatterSequence += 1;
                  return [{ lastValue: nextMatterSequence }];
                },
              }),
            };
          }

          if (table === fields) {
            const fieldValues = Array.isArray(value) ? value : [value];
            for (const fieldValue of fieldValues) {
              if (isInsertedWorkspaceField(fieldValue)) {
                insertedFields.push(fieldValue);
              }
            }
            return undefined;
          }

          if (
            table === auditLogs ||
            table === entities ||
            table === entityVersions ||
            table === properties ||
            table === workspaces
          ) {
            return undefined;
          }

          throw new Error("Unexpected insert table");
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
      execute: async () => undefined,
    };

    const { safeDb, scopedDb } = createScopedDbMock(tx);
    const result = await duplicateWorkspace.handler(
      createContext({ includeContent: true, safeDb, scopedDb }),
    );

    expect(result).toEqual({ workspaceId: expect.any(String) });
    const duplicatedWorkspaceId = readDuplicatedWorkspaceId(result);
    expect(insertedFields).toHaveLength(1);

    const copiedContent = insertedFields.at(0)?.content;
    expect(copiedContent?.type).toBe("file");
    if (copiedContent?.type !== "file") {
      throw new Error("Expected copied field content to be a file");
    }

    expect(copiedContent.id).not.toBe(imageContent.id);
    expect(copiedContent.pdfFileId).not.toBe(imageContent.pdfFileId);
    expect(copiedContent.thumbnailFileId).not.toBe(
      imageContent.thumbnailFileId,
    );
    expect(copiedContent.placeholder).toBe(imageContent.placeholder);
    expect(copiedContent.thumbnailDerivative).toEqual({ status: "ready" });

    // The duplicate owns the file, its PDF rendition, and its thumbnail: each
    // remapped id addresses an object of its own holding the source bytes,
    // and the source objects are untouched.
    expect(new Set(fake.objects.keys())).toEqual(
      new Set([
        ...sourceKeys,
        objectKey(
          duplicatedWorkspaceId,
          copiedContent.id,
          copiedContent.mimeType,
        ),
        objectKey(
          duplicatedWorkspaceId,
          copiedContent.pdfFileId ?? "",
          PDF_MIME_TYPE,
        ),
        objectKey(
          duplicatedWorkspaceId,
          copiedContent.thumbnailFileId ?? "",
          THUMBNAIL_MIME_TYPE,
        ),
      ]),
    );
    // The bytes never travel through the API task.
    expect(requestKeys("GET")).toEqual([]);
  });

  test("marks the copies extraction will not index, inside the transaction", async () => {
    requestNativeExtractionRunsMock.mockClear();
    enqueueDocumentProcessingRunMock.mockClear();
    enqueueEntitySearchRepairsMock.mockClear();
    flushEntitySearchRepairsMock.mockClear();

    const filePropertyId = toSafeId<"property">("prop_file");
    const notePropertyId = toSafeId<"property">("prop_note");
    const documentContent: FieldContent = {
      type: "file",
      version: 1,
      id: "source-file-id",
      fileName: "evidence.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      // The copy inherits a PDF rendering, so a durable run can read text
      // from it and owns the copy's search projection.
      pdfFileId: "source-pdf-id",
      pdfDerivative: { status: "ready" },
    };
    seedSourceObject("source-file-id", "image/png");
    seedSourceObject("source-pdf-id", PDF_MIME_TYPE);
    const taskContent: FieldContent = {
      type: "text",
      version: 1,
      value: "Draft the settlement offer",
    };
    const sourceEntity = {
      parentId: null,
      status: "open",
      priority: null,
      dueDate: null,
      agendaKind: null,
      startAt: null,
      endAt: null,
      occurredAt: null,
      remindAt: null,
      allDay: null,
      timeZone: null,
      location: null,
      onlineMeetingUrl: null,
      availability: null,
      sensitivity: null,
      organizer: null,
      attendees: null,
      recurrence: null,
      agendaSource: null,
      sortOrder: null,
      metadata: null,
    };
    const insertedEntityIdsByName = new Map<string, string>();
    let nextSequence = 0;

    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        workspaces: {
          findFirst: async () => ({
            id: "ws_source123",
            name: "Smith v Jones",
            clientId: null,
            billingReference: null,
            color: null,
            leadUserId: null,
          }),
        },
        properties: {
          findMany: async () => [
            {
              id: filePropertyId,
              workspaceId: "ws_source123",
              name: "Document",
              status: "active",
              content: { type: "file", version: 1 },
              tool: null,
              system: false,
              kinds: ["document"],
            },
            {
              id: notePropertyId,
              workspaceId: "ws_source123",
              name: "Notes",
              status: "active",
              content: { type: "text", version: 1 },
              tool: null,
              system: false,
              kinds: ["task"],
            },
          ],
        },
        propertyDependencies: { findMany: async () => [] },
        workspaceViews: { findMany: async () => [] },
        workspaceMembers: { findMany: async () => [] },
        workspaceContacts: { findMany: async () => [] },
        organizationSettings: { findFirst: async () => null },
        entities: {
          findMany: async () => [
            {
              ...sourceEntity,
              id: "entity_document",
              kind: "document",
              name: "evidence.png",
              currentVersion: {
                id: "version_document",
                fields: [
                  { propertyId: filePropertyId, content: documentContent },
                ],
              },
            },
            {
              ...sourceEntity,
              id: "entity_task",
              kind: "task",
              name: "Settlement offer",
              currentVersion: {
                id: "version_task",
                fields: [{ propertyId: notePropertyId, content: taskContent }],
              },
            },
          ],
        },
      },
      select: (selectedFields: Record<string, unknown>) => {
        if ("total" in selectedFields) {
          return { from: () => ({ where: async () => [{ total: 0 }] }) };
        }

        if ("name" in selectedFields) {
          return { from: () => ({ where: async () => [] }) };
        }

        throw new Error("Unexpected select fields");
      },
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === documentCounters || table === matterCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => {
                  nextSequence += 1;
                  return [{ lastValue: nextSequence }];
                },
              }),
            };
          }

          if (table === entities && isInsertedEntity(value)) {
            insertedEntityIdsByName.set(value.name, value.id);
            return undefined;
          }

          if (
            table === auditLogs ||
            table === entityVersions ||
            table === fields ||
            table === properties ||
            table === workspaces
          ) {
            return undefined;
          }

          throw new Error("Unexpected insert table");
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      execute: async () => undefined,
    });

    const result = await duplicateWorkspace.handler(
      createContext({ includeContent: true, safeDb, scopedDb }),
    );

    expect(result).toEqual({ workspaceId: expect.any(String) });

    const copiedDocumentId = insertedEntityIdsByName.get("evidence.png");
    const copiedTaskId = insertedEntityIdsByName.get("Settlement offer");
    if (!(copiedDocumentId && copiedTaskId)) {
      throw new Error("Expected both copies to be inserted");
    }

    // The task has no extraction run to index it, so its mark is written
    // with the copies themselves; the document's projection arrives with the
    // extraction that owns it, and marking it too would index it twice.
    expect(enqueueEntitySearchRepairsMock).toHaveBeenCalledTimes(1);
    expect(enqueueEntitySearchRepairsMock.mock.calls.at(0)?.at(1)).toEqual([
      copiedTaskId,
    ]);
    expect(requestNativeExtractionRunsMock).toHaveBeenCalledTimes(1);
    expect(enqueueDocumentProcessingRunMock.mock.calls).toEqual([
      [toSafeId<"documentProcessingRun">("run_0")],
    ]);
  });

  test("returns every object copied for an aborted duplicate", async () => {
    const sourceKey = seedSourceObject("source-file-id", "image/png");
    enqueueEntitySearchRepairsMock.mockClear();
    enqueueWorkspaceSearchRepairsMock.mockClear();

    const filePropertyId = toSafeId<"property">("prop_file");
    const insertedTables: unknown[] = [];

    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        workspaces: {
          findFirst: async () => ({
            id: "ws_source123",
            name: "Smith v Jones",
            clientId: null,
            billingReference: null,
            color: null,
            leadUserId: null,
          }),
        },
        properties: {
          findMany: async () => [
            {
              id: filePropertyId,
              workspaceId: "ws_source123",
              name: "Document",
              status: "active",
              content: { type: "file", version: 1 },
              tool: null,
              system: false,
              kinds: ["document"],
            },
          ],
        },
        propertyDependencies: { findMany: async () => [] },
        workspaceViews: { findMany: async () => [] },
        workspaceMembers: { findMany: async () => [] },
        workspaceContacts: { findMany: async () => [] },
        organizationSettings: { findFirst: async () => null },
        entities: {
          findMany: async () => [
            {
              id: "entity_document",
              kind: "document",
              name: "evidence.png",
              parentId: null,
              currentVersion: {
                id: "version_document",
                fields: [
                  {
                    propertyId: filePropertyId,
                    content: {
                      type: "file",
                      version: 1,
                      id: "source-file-id",
                      fileName: "evidence.png",
                      mimeType: "image/png",
                      sizeBytes: 1024,
                      encrypted: false,
                      sha256Hex: "a".repeat(64),
                      pdfFileId: null,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      select: (selectedFields: Record<string, unknown>) =>
        "total" in selectedFields
          ? {
              from: () => ({
                where: async () => [{ total: LIMITS.workspacesCount }],
              }),
            }
          : { from: () => ({ where: async () => [] }) },
      insert: (table: unknown) => ({
        values: () => {
          insertedTables.push(table);
          return {
            onConflictDoUpdate: () => ({
              returning: async () => [{ lastValue: 1 }],
            }),
          };
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      execute: async () => undefined,
    });

    const result = await duplicateWorkspace.handler(
      createContext({ includeContent: true, safeDb, scopedDb }),
    );

    // The abort travels as the same rejection the caller always answered.
    expect(result).toEqual({
      code: 400,
      response: { message: "Workspaces limit reached" },
    });
    expect(insertedTables).toEqual([]);

    // No row survives the abort, so every object copied for it is an orphan
    // and all of them go back.
    const copiedKeys = requestKeys("COPY");
    const deletedKeys = requestKeys("DELETE");
    expect(copiedKeys).toHaveLength(1);
    expect(new Set(deletedKeys)).toEqual(new Set(copiedKeys));
    // The store is back to the source object alone.
    expect([...fake.objects.keys()]).toEqual([sourceKey]);

    expect(enqueueEntitySearchRepairsMock).not.toHaveBeenCalled();
    expect(enqueueWorkspaceSearchRepairsMock).not.toHaveBeenCalled();
  });

  test("rejects an oversized source before the duplicate writes anything", async () => {
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        workspaces: {
          findFirst: async () => ({
            id: "ws_source123",
            name: "Smith v Jones",
            clientId: null,
            billingReference: null,
            color: null,
            leadUserId: null,
          }),
        },
        properties: { findMany: async () => [] },
        propertyDependencies: { findMany: async () => [] },
        workspaceViews: { findMany: async () => [] },
        workspaceMembers: { findMany: async () => [] },
        workspaceContacts: { findMany: async () => [] },
        organizationSettings: { findFirst: async () => null },
        entities: {
          // One past the cap the source read allows through.
          findMany: async () =>
            Array.from(
              { length: LIMITS.entitiesCount + 1 },
              (_unused, index) => ({
                id: `entity_${index}`,
                kind: "task",
                name: `Task ${index}`,
                parentId: null,
                currentVersion: { id: `version_${index}`, fields: [] },
              }),
            ),
        },
      },
      select: () => {
        throw new Error("Duplicate read the target matter before validating");
      },
      insert: () => {
        throw new Error("Duplicate wrote before validating the source size");
      },
      execute: async () => undefined,
    });

    const result = await duplicateWorkspace.handler(
      createContext({ includeContent: true, safeDb, scopedDb }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Entities limit reached" },
    });
    expect(requestKeys("COPY")).toEqual([]);
  });
});
