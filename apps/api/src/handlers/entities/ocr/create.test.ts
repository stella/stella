import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { documentProcessingRuns } from "@/api/db/schema";
import { requestManualOcrHandler } from "@/api/handlers/entities/ocr/create";
import { toSafeId } from "@/api/lib/branded-types";
import {
  classifyManualOcrCollision,
  persistManualOcrRun,
} from "@/api/lib/document-processing-request";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const rootTransactionMock = mock();
const recordAuditEvent = mock(async () => undefined);

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

test("manual OCR collisions preserve owners and restart post-projection promotions", () => {
  for (const status of ["queued", "running"] as const) {
    expect(
      classifyManualOcrCollision({
        errorCode: null,
        projectionState: "absent",
        requestSource: "manual",
        status,
      }),
    ).toBe("reuse");
  }

  expect(
    classifyManualOcrCollision({
      errorCode: null,
      projectionState: "different",
      requestSource: "upload",
      status: "running",
    }),
  ).toBe("retry");
  for (const projectionState of ["absent", "matching"] as const) {
    expect(
      classifyManualOcrCollision({
        errorCode: null,
        projectionState,
        requestSource: "upload",
        status: "running",
      }),
    ).toBe("promote");
  }
});

describe("requestManualOcrHandler", () => {
  test("queues a durable run for an extension-resolved unencrypted PDF field", async () => {
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
        recordAuditEvent,
        safeDb: createSafeDb({
          content: {
            encrypted: false,
            fileName: "scan.pdf",
            id: "00000000-0000-4000-8000-000000000001",
            mimeType: "application/octet-stream",
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
  });

  test("reports an already processed outcome for a succeeded run", async () => {
    const persistRun = mock(async () => ({
      id: runId,
      status: "succeeded" as const,
    }));
    const result = await Result.gen(() =>
      requestManualOcrHandler({
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

    expect(result).toEqual(Result.ok({ outcome: "already_processed", runId }));
  });

  test.each([
    "manual_selection_superseded",
    "source_superseded",
    "workspace_unavailable",
  ] as const)(
    "requeues a %s run after the current source is locked",
    async (errorCode) => {
      let retrySet: unknown;
      let retryWhere: SQL | undefined;
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
            const isRetryUpdate =
              typeof set === "object" && set && "requestSource" in set;
            if (isRetryUpdate) {
              retrySet = set;
            }
            return {
              where: (condition: SQL) => {
                if (isRetryUpdate) {
                  retryWhere = condition;
                }
                return {
                  returning: async () => [
                    { id: runId, status: "queued" as const },
                  ],
                };
              },
            };
          },
        }),
      });
      rootTransactionMock.mockImplementationOnce(
        async (operation: (transaction: Transaction) => Promise<unknown>) =>
          await operation(tx),
      );

      const run = await persistManualOcrRun({
        db: { transaction: rootTransactionMock },
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
      expect(retryWhere).toBeDefined();
      if (retryWhere) {
        const compiled = new PgDialect().sqlToQuery(retryWhere);
        expect(compiled.params).toEqual(
          expect.arrayContaining([
            "policy_disabled",
            "manual_selection_superseded",
            "source_superseded",
            "workspace_unavailable",
          ]),
        );
      }
      expect(recordAuditEvent).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          metadata: expect.objectContaining({ operation: "ocr", runId }),
        }),
      );
    },
  );

  test.each([
    ["upload", "queued"],
    ["repair", "queued"],
    ["upload", "running"],
    ["repair", "running"],
  ] as const)(
    "promotes an existing %s run in %s state without leaving the configured batch",
    async (requestSource, status) => {
      let selectCount = 0;
      let updateSet: unknown;
      let updateWhere: SQL | undefined;
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
                        requestSource,
                        status,
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          return {
            from: () => ({
              where: () => ({ limit: async () => [] }),
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
            const isPromotion =
              typeof set === "object" && set && "requestSource" in set;
            if (isPromotion) {
              updateSet = set;
            }
            return {
              where: (condition: SQL) => {
                if (isPromotion) {
                  updateWhere = condition;
                }
                return {
                  returning: async () => [{ id: runId, status }],
                };
              },
            };
          },
        }),
      });
      rootTransactionMock.mockImplementationOnce(
        async (operation: (transaction: Transaction) => Promise<unknown>) =>
          await operation(tx),
      );

      const run = await persistManualOcrRun({
        db: { transaction: rootTransactionMock },
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

      expect(run).toEqual({ id: runId, status });
      expect(updateSet).toEqual(
        expect.objectContaining({
          requestSource: "manual",
          requestedBy: userId,
        }),
      );
      expect(updateWhere).toBeDefined();
      if (updateWhere) {
        const compiled = new PgDialect().sqlToQuery(updateWhere);
        expect(compiled.params).toEqual(
          expect.arrayContaining([runId, "queued", "running"]),
        );
      }
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
                limit: async () =>
                  hasProjection
                    ? [
                        {
                          sourceEntityVersionId: entityVersionId,
                          sourceFieldId: fieldId,
                          sourceFileId: "00000000-0000-4000-8000-000000000001",
                          sourceSha256Hex: "a".repeat(64),
                        },
                      ]
                    : [],
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
            if (typeof set === "object" && set && "requestSource" in set) {
              updateSet = set;
            }
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
        db: { transaction: rootTransactionMock },
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

  test("cancels every competing manual selection before acknowledging the latest request", async () => {
    const events: string[] = [];
    let cancellationSet: Record<string, unknown> | undefined;
    let cancellationWhere: SQL | undefined;
    let selectCount = 0;
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: runId, status: "queued" as const }],
          }),
        }),
      }),
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
              limit: async () => [{ content: sourceFileContent }],
            }),
          }),
        };
      },
      update: () => ({
        set: (value: Record<string, unknown>) => {
          cancellationSet = value;
          return {
            where: async (condition: SQL) => {
              cancellationWhere = condition;
              events.push("cancel");
            },
          };
        },
      }),
    });
    rootTransactionMock.mockImplementationOnce(
      async (operation: (transaction: Transaction) => Promise<unknown>) =>
        await operation(tx),
    );

    const run = await persistManualOcrRun({
      db: { transaction: rootTransactionMock },
      organizationId,
      recordAuditEvent: async () => {
        events.push("audit");
      },
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

    expect(run).toEqual({ id: runId, status: "queued" });
    expect(cancellationSet).toEqual(
      expect.objectContaining({
        claimedAt: null,
        claimedBy: null,
        errorCode: "manual_selection_superseded",
        nextAttemptAt: null,
        status: "cancelled",
      }),
    );
    expect(cancellationWhere).toBeDefined();
    if (cancellationWhere) {
      const compiled = new PgDialect().sqlToQuery(cancellationWhere);
      expect(compiled.sql).toContain('"document_processing_runs"."id" <>');
      expect(compiled.params).toEqual(
        expect.arrayContaining([
          organizationId,
          workspaceId,
          entityId,
          entityVersionId,
          "ocr",
          "manual",
          runId,
          "queued",
          "running",
        ]),
      );
    }
    expect(events).toEqual(["cancel", "audit"]);
  });

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
      db: { transaction: rootTransactionMock },
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
      db: { transaction: rootTransactionMock },
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
