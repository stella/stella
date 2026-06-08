import { describe, expect, mock, test } from "bun:test";

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
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const s3FileMock = mock((key: string) => ({ key }));
const s3WriteMock = mock(async () => undefined);
const s3DeleteMock = mock(async () => undefined);

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({
    delete: s3DeleteMock,
    file: s3FileMock,
    write: s3WriteMock,
  }),
}));

const processExtractionMock = mock(async () => undefined);
void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
}));

const upsertWorkspaceSearchDocumentMock = mock(async () => undefined);
const syncWorkspaceSearchActivityMock = mock(async () => undefined);
void mock.module("@/api/lib/search/index-global", () => ({
  syncWorkspaceSearchActivity: syncWorkspaceSearchActivityMock,
  upsertWorkspaceSearchDocument: upsertWorkspaceSearchDocumentMock,
}));

const { default: duplicateWorkspace } = await import("./duplicate");

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

  test("copies and remaps image thumbnail refs when duplicating content", async () => {
    s3FileMock.mockClear();
    s3WriteMock.mockClear();
    s3DeleteMock.mockClear();
    processExtractionMock.mockClear();
    syncWorkspaceSearchActivityMock.mockClear();
    upsertWorkspaceSearchDocumentMock.mockClear();

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
    expect(s3WriteMock).toHaveBeenCalledTimes(3);
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
  });
});
