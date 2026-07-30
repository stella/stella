import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { documentProcessingRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const rootTransactionMock = mock();
const enqueueDocumentProcessingRunMock = mock(async () => undefined);
const recordAuditEvent = mock(async () => undefined);

void mock.module("@/api/db/root", () => ({
  rootDb: { transaction: rootTransactionMock },
}));
void mock.module("@/api/lib/document-processing-enqueue", () => ({
  enqueueDocumentProcessingRun: enqueueDocumentProcessingRunMock,
}));
const { requestManualOcrHandler } =
  await import("@/api/handlers/entities/ocr/create");
const { persistManualOcrRun } =
  await import("@/api/lib/document-processing-request");

const entityId = toSafeId<"entity">("entity_test");
const entityVersionId = toSafeId<"entityVersion">("version_test");
const fieldId = toSafeId<"field">("field_test");
const organizationId = toSafeId<"organization">("org_test");
const workspaceId = toSafeId<"workspace">("workspace_test");
const userId = toSafeId<"user">("user_test");
const runId =
  asTestRaw<(typeof documentProcessingRuns.$inferSelect)["id"]>("run_test");
const sourceFileContent = {
  encrypted: false,
  fileName: "scan.pdf",
  id: "00000000-0000-4000-8000-000000000001",
  mimeType: PDF_MIME_TYPE,
  pdfFileId: null,
  sha256Hex: "a".repeat(64),
  sizeBytes: 123,
  type: "file" as const,
  version: 1 as const,
};

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
  test("rejects before persistence when no OCR worker is ready", async () => {
    const persistRun = mock(async () => ({
      id: runId,
      status: "queued" as const,
    }));
    const result = await Result.gen(() =>
      requestManualOcrHandler({
        entityId,
        fieldId,
        organizationId,
        persistRun,
        workerAvailable: async () => false,
        recordAuditEvent,
        safeDb: createSafeDb(null),
        userId,
        workspaceId,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 502 });
    }
    expect(persistRun).not.toHaveBeenCalled();
  });

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
        workerAvailable: async () => true,
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

    expect(result).toEqual(Result.ok({ outcome: "queued", runId }));
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

  test("acknowledges a durable run when immediate queue delivery fails", async () => {
    const captureEnqueueError = mock(() => undefined);
    const enqueueFailure = new Error("queue temporarily unavailable");
    const enqueue = mock(async () => {
      throw enqueueFailure;
    });
    const persistRun = mock(async () => ({
      id: runId,
      status: "queued" as const,
    }));
    const result = await Result.gen(() =>
      requestManualOcrHandler({
        captureEnqueueError,
        enqueue,
        entityId,
        fieldId,
        organizationId,
        persistRun,
        workerAvailable: async () => true,
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

    expect(result).toEqual(Result.ok({ outcome: "queued", runId }));
    expect(enqueue).toHaveBeenCalledWith(runId);
    expect(captureEnqueueError).toHaveBeenCalledWith(enqueueFailure, {
      runId,
    });
  });

  test("reports an already processed outcome without enqueueing a succeeded run", async () => {
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
        workerAvailable: async () => true,
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

    expect(result).toEqual(Result.ok({ outcome: "already_processed", runId }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  test.each(["source_superseded", "workspace_unavailable"] as const)(
    "requeues a %s run after the current source is locked",
    async (errorCode) => {
      let retrySet: unknown;
      let selectCount = 0;
      const tx = asTestRaw<Transaction>({
        select: () => {
          selectCount += 1;
          if (selectCount <= 2) {
            return {
              from: () => ({
                where: () => ({
                  limit: () => ({ for: async () => [{ id: entityId }] }),
                }),
              }),
            };
          }
          if (selectCount === 3) {
            return {
              from: () => ({
                where: () => ({
                  limit: async () => [{ content: sourceFileContent }],
                }),
              }),
            };
          }
          return {
            from: () => ({
              where: () => ({
                limit: () => ({
                  for: async () => [
                    {
                      errorCode,
                      id: runId,
                      requestSource: "upload" as const,
                      status: "cancelled" as const,
                    },
                  ],
                }),
              }),
            }),
          };
        },
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: async () => [] }),
          }),
        }),
        update: () => ({
          set: (set: unknown) => {
            retrySet = set;
            return {
              where: () => ({
                returning: async () => [
                  { id: runId, status: "queued" as const },
                ],
              }),
            };
          },
        }),
      });
      rootTransactionMock.mockImplementationOnce(
        async (operation: (transaction: Transaction) => Promise<unknown>) =>
          await operation(tx),
      );

      const run = await persistManualOcrRun({
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

      expect(run).toEqual({ id: runId, status: "queued" });
      expect(retrySet).toEqual(
        expect.objectContaining({
          errorCode: null,
          requestSource: "manual",
          status: "queued",
        }),
      );
      expect(recordAuditEvent).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          metadata: expect.objectContaining({ operation: "ocr", runId }),
        }),
      );
    },
  );

  test.each(["upload", "repair"] as const)(
    "promotes a queued %s run to a manual request",
    async (requestSource) => {
      let selectCount = 0;
      let updateSet: unknown;
      const tx = asTestRaw<Transaction>({
        select: () => {
          selectCount += 1;
          if (selectCount <= 2) {
            return {
              from: () => ({
                where: () => ({
                  limit: () => ({ for: async () => [{ id: entityId }] }),
                }),
              }),
            };
          }
          if (selectCount === 3) {
            return {
              from: () => ({
                where: () => ({
                  limit: async () => [{ content: sourceFileContent }],
                }),
              }),
            };
          }
          return {
            from: () => ({
              where: () => ({
                limit: () => ({
                  for: async () => [
                    {
                      errorCode: null,
                      id: runId,
                      requestSource,
                      status: "queued" as const,
                    },
                  ],
                }),
              }),
            }),
          };
        },
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: async () => [] }),
          }),
        }),
        update: () => ({
          set: (set: unknown) => {
            updateSet = set;
            return {
              where: () => ({
                returning: async () => [
                  { id: runId, status: "queued" as const },
                ],
              }),
            };
          },
        }),
      });
      rootTransactionMock.mockImplementationOnce(
        async (operation: (transaction: Transaction) => Promise<unknown>) =>
          await operation(tx),
      );

      const run = await persistManualOcrRun({
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

      expect(run).toEqual({ id: runId, status: "queued" });
      expect(updateSet).toEqual(
        expect.objectContaining({
          requestSource: "manual",
          requestedBy: userId,
        }),
      );
    },
  );

  test.each([
    { expectedStatus: "queued" as const, hasProjection: false },
    { expectedStatus: "succeeded" as const, hasProjection: true },
  ])(
    "restores a succeeded run only when its exact projection is missing",
    async ({ expectedStatus, hasProjection }) => {
      let selectCount = 0;
      let updateSet: unknown;
      const tx = asTestRaw<Transaction>({
        select: () => {
          selectCount += 1;
          if (selectCount <= 2) {
            return {
              from: () => ({
                where: () => ({
                  limit: () => ({ for: async () => [{ id: entityId }] }),
                }),
              }),
            };
          }
          if (selectCount === 3) {
            return {
              from: () => ({
                where: () => ({
                  limit: async () => [{ content: sourceFileContent }],
                }),
              }),
            };
          }
          if (selectCount === 4) {
            return {
              from: () => ({
                where: () => ({
                  limit: () => ({
                    for: async () => [
                      {
                        errorCode: null,
                        id: runId,
                        requestSource: "upload" as const,
                        status: "succeeded" as const,
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          return {
            from: () => ({
              where: () => ({
                limit: async () => (hasProjection ? [{ entityId }] : []),
              }),
            }),
          };
        },
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: async () => [] }),
          }),
        }),
        update: () => ({
          set: (set: unknown) => {
            updateSet = set;
            return {
              where: () => ({
                returning: async () => [
                  { id: runId, status: "queued" as const },
                ],
              }),
            };
          },
        }),
      });
      rootTransactionMock.mockImplementationOnce(
        async (operation: (transaction: Transaction) => Promise<unknown>) =>
          await operation(tx),
      );

      const run = await persistManualOcrRun({
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

      expect(run).toEqual({ id: runId, status: expectedStatus });
      if (hasProjection) {
        expect(updateSet).toBeUndefined();
        return;
      }
      expect(updateSet).toEqual(
        expect.objectContaining({
          requestSource: "manual",
          status: "queued",
        }),
      );
    },
  );

  test("rejects a field changed after initial validation", async () => {
    let selectCount = 0;
    const insert = mock(() => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => [] }),
      }),
    }));
    const tx = asTestRaw<Transaction>({
      insert,
      select: () => {
        selectCount += 1;
        if (selectCount <= 2) {
          return {
            from: () => ({
              where: () => ({
                limit: () => ({ for: async () => [{ id: entityId }] }),
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [
                {
                  content: {
                    ...sourceFileContent,
                    sha256Hex: "b".repeat(64),
                  },
                },
              ],
            }),
          }),
        };
      },
    });
    rootTransactionMock.mockImplementationOnce(
      async (operation: (transaction: Transaction) => Promise<unknown>) =>
        await operation(tx),
    );

    const run = await persistManualOcrRun({
      organizationId,
      recordAuditEvent,
      source: {
        entityId,
        entityVersionId,
        fieldId,
        sourceFileId: sourceFileContent.id,
        sourceSha256Hex: sourceFileContent.sha256Hex,
      },
      userId,
      workspaceId,
    });

    expect(run).toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });

  test("locks the source only while its workspace is active", async () => {
    let selectCount = 0;
    let workspaceWhere: SQL | undefined;
    const tx = asTestRaw<Transaction>({
      select: () => {
        selectCount += 1;
        return {
          from: () => ({
            where: (condition: SQL) => {
              if (selectCount === 2) {
                workspaceWhere = condition;
              }
              return {
                limit: () => ({
                  for: async () =>
                    selectCount === 1 ? [{ id: entityId }] : [],
                }),
              };
            },
          }),
        };
      },
    });
    rootTransactionMock.mockImplementationOnce(
      async (operation: (transaction: Transaction) => Promise<unknown>) =>
        await operation(tx),
    );

    const run = await persistManualOcrRun({
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

    expect(run).toBeNull();
    expect(workspaceWhere).toBeDefined();
    if (workspaceWhere) {
      const compiled = new PgDialect().sqlToQuery(workspaceWhere);
      expect(compiled.sql).toContain('"workspaces"."status" =');
      expect(compiled.params).toContain("active");
    }
  });
});
