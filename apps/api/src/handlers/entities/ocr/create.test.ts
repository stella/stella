import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";

import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { documentProcessingRuns, entities, workspaces } from "@/api/db/schema";
import { createMockDatabase } from "@/api/db/sql-client";
import { requestManualOcrHandler } from "@/api/handlers/entities/ocr/create";
import { toSafeId } from "@/api/lib/branded-types";
import {
  classifyManualOcrCollision,
  persistManualOcrRun,
} from "@/api/lib/document-processing-request";
import type { PersistManualOcrRunOptions } from "@/api/lib/document-processing-request";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

beforeEach(() => {
  recordAuditEvent.mockClear();
  rootTransactionMock.mockReset();
});

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

const executeParentLock = async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  expect(compiled.sql).toContain("FOR ");
  if (compiled.sql.includes('FROM "organization"')) {
    expect(compiled.params).toEqual([organizationId]);
    return [{ id: organizationId }];
  }
  if (compiled.sql.includes('"entities"')) {
    return [{ id: entityId }];
  }
  if (compiled.sql.includes('"document_processing_runs"')) {
    return [{ id: runId }];
  }
  expect(compiled.sql).toContain('"workspaces"');
  expect(compiled.params).toContain(workspaceId);
  return [{ id: workspaceId }];
};

const createSourceLockSelect = (selectCount: number) => {
  if (selectCount === 1) {
    const query = createMockDatabase()
      .select({ id: workspaces.id, organizationId: workspaces.organizationId })
      .from(workspaces);
    return {
      from: () =>
        Object.assign(query, {
          for: async () => [{ id: workspaceId, organizationId }],
        }),
    };
  }
  const query = createMockDatabase()
    .select({ id: entities.id, workspaceId: entities.workspaceId })
    .from(entities);
  return {
    from: () =>
      Object.assign(query, {
        for: async () => [{ id: entityId, workspaceId }],
      }),
  };
};

type LockedRun = Pick<
  typeof documentProcessingRuns.$inferSelect,
  | "attemptCount"
  | "errorCode"
  | "id"
  | "requestSource"
  | "status"
  | "workspaceId"
>;

const lockedRunSelect = (run: LockedRun) => ({
  from: () => {
    const query = new QueryBuilder().select().from(documentProcessingRuns);
    return {
      toSQL: () => query.toSQL(),
      as: (alias: string) => query.as(alias),
      where: (predicate: SQL) => {
        const scoped = query.where(predicate);
        return {
          toSQL: () => scoped.toSQL(),
          as: (alias: string) => scoped.as(alias),
          for: async () => [run],
        };
      },
    };
  },
});

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
        attemptCount: 0,
        errorCode: null,
        projectionState: "absent",
        requestSource: "manual",
        status,
      }),
    ).toBe("reuse");
  }

  expect(
    classifyManualOcrCollision({
      attemptCount: 0,
      errorCode: null,
      projectionState: "different",
      requestSource: "upload",
      status: "running",
    }),
  ).toBe("retry");
  for (const projectionState of ["absent", "matching"] as const) {
    expect(
      classifyManualOcrCollision({
        attemptCount: 0,
        errorCode: null,
        projectionState,
        requestSource: "upload",
        status: "running",
      }),
    ).toBe("promote");
  }
});

test("manual OCR starts a fresh retry across failed request sources", () => {
  for (const requestSource of ["manual", "upload", "repair"] as const) {
    for (const attemptCount of [4, 5, 6]) {
      expect(
        classifyManualOcrCollision({
          attemptCount,
          errorCode: "search_index_failed",
          projectionState: "absent",
          requestSource,
          status: "failed",
        }),
      ).toBe("retry");
    }
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
        readAvailability: async () => DOCUMENT_OCR_AVAILABILITY.live,
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

    expect(result).toEqual(
      Result.ok({
        outcome: "queued",
        runId,
        availability: DOCUMENT_OCR_AVAILABILITY.live,
      }),
    );
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
        readAvailability: async () => DOCUMENT_OCR_AVAILABILITY.live,
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

  const pdfFieldRow = {
    content: sourceFileContent,
    entityId,
    entityVersionId,
    fieldId,
    readOnly: false,
    versionDeletedAt: null,
  };

  test.each([
    DOCUMENT_OCR_AVAILABILITY.live,
    DOCUMENT_OCR_AVAILABILITY.batched,
  ])("queues while OCR is $type and reports when it runs", async (status) => {
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
        readAvailability: async () => status,
        recordAuditEvent,
        safeDb: createSafeDb(pdfFieldRow),
        userId,
        workspaceId,
      }),
    );

    expect(result).toEqual(
      Result.ok({ outcome: "queued", runId, availability: status }),
    );
    expect(persistRun).toHaveBeenCalledTimes(1);
  });

  test("refuses before persisting anything while OCR is unconfigured", async () => {
    const persistRun = mock(async () => ({
      id: runId,
      status: "queued" as const,
    }));
    let reads = 0;
    const safeDb: SafeDb = async (callback) => {
      reads += 1;
      return await createSafeDb(pdfFieldRow)(callback);
    };
    const result = await Result.gen(() =>
      requestManualOcrHandler({
        entityId,
        fieldId,
        organizationId,
        persistRun,
        readAvailability: async () => DOCUMENT_OCR_AVAILABILITY.unconfigured,
        recordAuditEvent,
        safeDb,
        userId,
        workspaceId,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(HandlerError);
      expect(result.error).toMatchObject({ status: 503, retryable: true });
    }
    expect(persistRun).not.toHaveBeenCalled();
    expect(reads).toBe(0);
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
        execute: executeParentLock,
        select: () => {
          selectCount += 1;
          if (selectCount <= 2) {
            return createSourceLockSelect(selectCount);
          }
          if (selectCount === 5) {
            return lockedRunSelect({
              attemptCount: 0,
              errorCode,
              id: runId,
              requestSource: "upload",
              status: "cancelled",
              workspaceId,
            });
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
                limit: async () => [
                  {
                    errorCode,
                    id: runId,
                    requestSource: "upload" as const,
                    status: "cancelled" as const,
                  },
                ],
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
        execute: executeParentLock,
        select: () => {
          selectCount += 1;
          if (selectCount <= 2) {
            return createSourceLockSelect(selectCount);
          }
          if (selectCount === 5) {
            return lockedRunSelect({
              attemptCount: 0,
              errorCode: null,
              id: runId,
              requestSource,
              status,
              workspaceId,
            });
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
                  limit: async () => [
                    {
                      errorCode: null,
                      id: runId,
                      requestSource,
                      status,
                    },
                  ],
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
        execute: executeParentLock,
        select: () => {
          selectCount += 1;
          if (selectCount <= 2) {
            return createSourceLockSelect(selectCount);
          }
          if (selectCount === 5) {
            return lockedRunSelect({
              attemptCount: 0,
              errorCode: null,
              id: runId,
              requestSource: "upload",
              status: "succeeded",
              workspaceId,
            });
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
                  limit: async () => [
                    {
                      errorCode: null,
                      id: runId,
                      requestSource: "upload" as const,
                      status: "succeeded" as const,
                    },
                  ],
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
      execute: executeParentLock,
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
          return createSourceLockSelect(selectCount);
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
      execute: executeParentLock,
      insert,
      select: () => {
        selectCount += 1;
        if (selectCount <= 2) {
          return createSourceLockSelect(selectCount);
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
    let workspaceQuery: { sql: string; params: unknown[] } | undefined;
    const tx = asTestRaw<Transaction>({
      execute: executeParentLock,
      select: () => {
        const query = createMockDatabase()
          .select({
            id: workspaces.id,
            organizationId: workspaces.organizationId,
          })
          .from(workspaces);
        return {
          from: () =>
            Object.assign(query, {
              for: async () => {
                workspaceQuery = query.toSQL();
                return [];
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
    expect(workspaceQuery).toBeDefined();
    if (workspaceQuery) {
      expect(workspaceQuery.sql).toContain('"workspaces"."status" =');
      expect(workspaceQuery.params).toContain("active");
    }
  });
});

/**
 * These directives pin requiredness: the helper's `db` and the handler's
 * `persistRun` are required inputs, so omitting either fails the typecheck.
 * They do not rule out a default, since a destructuring default behind a
 * still-required type would pass them. That is held elsewhere: restoring
 * `db = rootDb` is a parameter default that the
 * `implicit-root-connection-shapes` ratchet counts, and
 * `document-processing-request.ts` no longer has a baseline entry there.
 * Swapping the route's door for another
 * root-bound persister needs a new `rootDb` import, which the
 * `direct-root-connection-imports` ratchet and the door's import confinement
 * reject.
 */
describe("the manual OCR request's connection is a required input", () => {
  const source = {
    entityId,
    entityVersionId,
    fieldId,
    sourceFileId: "00000000-0000-4000-8000-000000000001",
    sourceSha256Hex: "a".repeat(64),
  };
  const persistOptions = (options: PersistManualOcrRunOptions) => options;
  const handlerProps = (props: Parameters<typeof requestManualOcrHandler>[0]) =>
    props;

  test("the helper requires its connection", () => {
    // @ts-expect-error `db` is a required option
    persistOptions({
      organizationId,
      recordAuditEvent,
      source,
      userId,
      workspaceId,
    });
  });

  test("the handler requires its persister", () => {
    // @ts-expect-error `persistRun` is a required prop
    handlerProps({
      entityId,
      fieldId,
      organizationId,
      recordAuditEvent,
      safeDb: createSafeDb(null),
      userId,
      workspaceId,
    });
  });
});
