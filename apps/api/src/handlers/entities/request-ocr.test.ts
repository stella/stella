import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { documentProcessingRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const rootTransactionMock = mock();
const enqueueDocumentProcessingRunMock = mock(async () => undefined);
const recordAuditEvent = mock(async () => undefined);

void mock.module("@/api/db/root", () => ({
  rootDb: { transaction: rootTransactionMock },
}));
void mock.module("@/api/lib/document-processing-queue", () => ({
  enqueueDocumentProcessingRun: enqueueDocumentProcessingRunMock,
}));

const { requestManualOcrHandler } =
  await import("@/api/handlers/entities/request-ocr");

const entityId = toSafeId<"entity">("entity_test");
const entityVersionId = toSafeId<"entityVersion">("version_test");
const fieldId = toSafeId<"field">("field_test");
const organizationId = toSafeId<"organization">("org_test");
const workspaceId = toSafeId<"workspace">("workspace_test");
const userId = toSafeId<"user">("user_test");
const runId =
  asTestRaw<(typeof documentProcessingRuns.$inferSelect)["id"]>("run_test");

const createSafeDb =
  (content: unknown): SafeDb =>
  async (callback) => {
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({ limit: async () => [content] }),
            }),
          }),
        }),
      }),
    });
    return Result.ok(await callback(tx));
  };

describe("requestManualOcrHandler", () => {
  test("queues a durable run for the current unencrypted PDF field", async () => {
    const enqueue = mock(async () => undefined);
    const persistRun = mock(async () => ({
      id: runId,
      status: "queued" as const,
    }));
    const result = await Result.gen(() =>
      requestManualOcrHandler({
        enqueue,
        entityId,
        fieldId,
        organizationId,
        persistRun,
        recordAuditEvent,
        safeDb: createSafeDb({
          content: {
            encrypted: false,
            fileName: "scan.pdf",
            id: "00000000-0000-4000-8000-000000000001",
            mimeType: PDF_MIME_TYPE,
            pdfFileId: null,
            sha256Hex: "a".repeat(64),
            sizeBytes: 123,
            type: "file",
            version: 1,
          },
          entityId,
          entityVersionId,
          fieldId,
          readOnly: false,
          versionDeletedAt: null,
        }),
        userId,
        workspaceId,
      }),
    );

    expect(result).toEqual(Result.ok({ accepted: true, runId }));
    expect(persistRun).toHaveBeenCalledWith({
      organizationId,
      recordAuditEvent,
      source: {
        entityId,
        entityVersionId,
        fieldId,
        sourceFileId: "00000000-0000-4000-8000-000000000001",
        sourceSha256Hex: "a".repeat(64),
      },
      userId,
      workspaceId,
    });
    expect(enqueue).toHaveBeenCalledWith(runId);
  });

  test("does not enqueue an already terminal run", async () => {
    const enqueue = mock(async () => undefined);
    const persistRun = mock(async () => ({
      id: runId,
      status: "succeeded" as const,
    }));
    const result = await Result.gen(() =>
      requestManualOcrHandler({
        enqueue,
        entityId,
        fieldId,
        organizationId,
        persistRun,
        recordAuditEvent,
        safeDb: createSafeDb({
          content: {
            encrypted: false,
            fileName: "scan.pdf",
            id: "00000000-0000-4000-8000-000000000001",
            mimeType: PDF_MIME_TYPE,
            pdfFileId: null,
            sha256Hex: "a".repeat(64),
            sizeBytes: 123,
            type: "file",
            version: 1,
          },
          entityId,
          entityVersionId,
          fieldId,
          readOnly: false,
          versionDeletedAt: null,
        }),
        userId,
        workspaceId,
      }),
    );

    expect(result).toEqual(Result.ok({ accepted: true, runId }));
    expect(enqueue).not.toHaveBeenCalled();
  });
});
