import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { loadThread } from "./send-message-thread";

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");
const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-000000000003");
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000004",
);
const otherWorkspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000005",
);

describe("send-message thread loading", () => {
  test("rejects an existing thread whose scope differs from the request", async () => {
    const insert = mock(() => ({ values: async () => undefined }));
    const findFirst = mock(async () => ({
      chatModel: null,
      contextMatterIds: [],
      dataWorkspaceIds: [otherWorkspaceId],
      id: threadId,
      title: "Existing thread",
      rollbackToken: null,
      webSearchEnabled: false,
      workspaceId: otherWorkspaceId,
    }));
    const { safeDb } = createScopedDbMock({
      insert,
      query: {
        chatThreads: {
          findFirst,
        },
      },
    });

    const result = await loadThread({
      initialContextMatterIds: [],
      isAnonymized: false,
      organizationId,
      recordAuditEvent: async () => undefined,
      safeDb,
      threadId,
      title: "Incoming title",
      userId,
      workspaceId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected the scope mismatch to fail");
    }
    expect(result.error).toMatchObject({
      message: "Chat thread scope does not match request",
      status: 400,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { eq: threadId },
          organizationId: { eq: organizationId },
          userId: { eq: userId },
        },
      }),
    );
  });

  test("initializes a workspace thread with its workspace in the data scope", async () => {
    await expectCreatedThreadDataScope(workspaceId, [workspaceId]);
  });

  test("initializes an organization thread with an empty data scope", async () => {
    await expectCreatedThreadDataScope(null, []);
  });

  test("retries creation when rollback deletes before the adoption claim", async () => {
    const rollbackToken = "rollback-token";
    let lookupCount = 0;
    const insertValues = mock(async () => undefined);
    const claimReturning = mock(async () => []);
    const { safeDb } = createScopedDbMock({
      insert: () => ({ values: insertValues }),
      query: {
        chatThreads: {
          findFirst: async () => {
            lookupCount += 1;
            if (lookupCount > 1) {
              return null;
            }
            return {
              chatModel: null,
              contextMatterIds: [],
              dataWorkspaceIds: [workspaceId],
              id: threadId,
              title: "Concurrent thread",
              rollbackToken,
              webSearchEnabled: false,
              workspaceId,
            };
          },
        },
      },
      update: () => ({
        set: () => ({
          where: () => ({ returning: claimReturning }),
        }),
      }),
    });

    const result = await loadThread({
      initialContextMatterIds: [],
      isAnonymized: false,
      organizationId,
      recordAuditEvent: async () => undefined,
      safeDb,
      threadId,
      title: "New thread",
      userId,
      workspaceId,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.type).toBe("created");
    expect(claimReturning).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(1);
  });

  test("propagates an audit unique violation instead of treating it as a thread race", async () => {
    const auditUniqueError = new DatabaseError({
      code: PG_ERROR.UNIQUE_VIOLATION,
      message: "Audit event already exists",
      cause: Object.assign(new Error("duplicate audit event"), {
        code: PG_ERROR.UNIQUE_VIOLATION,
        constraint: "audit_log_event_id_key",
      }),
    });
    const tx = asTestRaw<Transaction>({
      insert: () => ({ values: async () => undefined }),
      query: { chatThreads: { findFirst: async () => null } },
    });
    const safeDb: SafeDb = async (callback) =>
      await Result.tryPromise({
        try: async () => await callback(tx),
        catch: () => auditUniqueError,
      });
    const recordAuditEvent = mock(async () => {
      throw auditUniqueError;
    });

    const result = await loadThread({
      initialContextMatterIds: [],
      isAnonymized: false,
      organizationId,
      recordAuditEvent,
      safeDb,
      threadId,
      title: "New thread",
      userId,
      workspaceId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected the audit write to fail");
    }
    expect(result.error).toBe(auditUniqueError);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });
});

const expectCreatedThreadDataScope = async (
  requestedWorkspaceId: SafeId<"workspace"> | null,
  expectedDataWorkspaceIds: SafeId<"workspace">[],
) => {
  const insertedRows: unknown[] = [];
  const insertValues = mock(async (values: unknown) => {
    insertedRows.push(values);
  });
  const recordAuditEvent = mock(async () => undefined);
  const { safeDb } = createScopedDbMock({
    insert: () => ({ values: insertValues }),
    query: { chatThreads: { findFirst: async () => null } },
  });

  const result = await loadThread({
    initialContextMatterIds: [],
    isAnonymized: false,
    organizationId,
    recordAuditEvent,
    safeDb,
    threadId,
    title: "New thread",
    userId,
    workspaceId: requestedWorkspaceId,
  });

  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw result.error;
  }
  if (result.value.type !== "created") {
    throw new Error("Expected a newly created thread");
  }
  expect(result.value).toMatchObject({
    type: "created",
    data: {
      dataWorkspaceIds: expectedDataWorkspaceIds,
      workspaceId: requestedWorkspaceId,
    },
    rollbackToken: expect.any(String),
  });
  expect(insertedRows).toEqual([
    expect.objectContaining({
      dataWorkspaceIds: expectedDataWorkspaceIds,
      rollbackToken: result.value.rollbackToken,
      workspaceId: requestedWorkspaceId,
    }),
  ]);
  expect(recordAuditEvent).toHaveBeenCalledTimes(1);
};
