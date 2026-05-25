import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import {
  documentCounters,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const s3WriteMock = mock(async () => {});
const s3DeleteMock = mock(async () => {});
const processExtractionMock = mock(async () => {});
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
  enqueuePdfDerivativeOrMarkFailed: enqueuePdfDerivativeOrMarkFailedMock,
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

describe("createEntityFromBuffer", () => {
  test("writes an entity create audit log with the DB insert", async () => {
    let nextDocumentSequence = 0;
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

          if (
            table === entities ||
            table === entityVersions ||
            table === fields
          ) {
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
          },
        },
      },
      resourceId: expect.any(String),
      resourceType: "entity",
    });
  });
});
