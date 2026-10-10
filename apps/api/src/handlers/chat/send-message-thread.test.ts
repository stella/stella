import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { CHAT_THREAD_PLACEHOLDER_TITLE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { chatThreads } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

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
      chatReasoningEffort: null,
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
      initialDataWorkspaceIds: [],
      initialContextMatterIds: [],
      organizationId,
      recordAuditEvent: async () => undefined,
      safeDb,
      subjectDecisionId: null,
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

  test("copies an origin draft's data scope before its first message persists", async () => {
    await expectCreatedThreadDataScope(
      null,
      [workspaceId, otherWorkspaceId],
      [workspaceId, otherWorkspaceId],
    );
  });

  test("keeps the destination workspace in a draft thread's inherited scope", async () => {
    await expectCreatedThreadDataScope(
      workspaceId,
      [workspaceId, otherWorkspaceId],
      [otherWorkspaceId],
    );
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
              chatReasoningEffort: null,
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
      initialDataWorkspaceIds: [],
      initialContextMatterIds: [],
      organizationId,
      recordAuditEvent: async () => undefined,
      safeDb,
      subjectDecisionId: null,
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
    const safeDb: SafeDb = async (operation) =>
      await Result.tryPromise({
        try: async () => await operation(tx),
        catch: () => auditUniqueError,
      });
    const recordAuditEvent = mock(async () => {
      throw auditUniqueError;
    });

    const result = await loadThread({
      initialDataWorkspaceIds: [],
      initialContextMatterIds: [],
      organizationId,
      recordAuditEvent,
      safeDb,
      subjectDecisionId: null,
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
  initialDataWorkspaceIds: SafeId<"workspace">[] = [],
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
    initialDataWorkspaceIds,
    initialContextMatterIds: [],
    organizationId,
    recordAuditEvent,
    safeDb,
    subjectDecisionId: null,
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

describe("the decision a thread is about", () => {
  const decisionId = toSafeId<"caseLawDecision">(
    "00000000-0000-0000-0000-000000000006",
  );

  test("a send that creates the thread records its decision", async () => {
    const insertedRows: unknown[] = [];
    const { safeDb } = createScopedDbMock({
      insert: () => ({
        values: async (values: unknown) => {
          insertedRows.push(values);
        },
      }),
      query: { chatThreads: { findFirst: async () => null } },
    });

    const result = await loadThread({
      initialDataWorkspaceIds: [],
      initialContextMatterIds: [],
      organizationId,
      recordAuditEvent: async () => undefined,
      safeDb,
      subjectDecisionId: decisionId,
      threadId,
      title: "New thread",
      userId,
      workspaceId: null,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(insertedRows).toEqual([
      expect.objectContaining({ subjectDecisionId: decisionId }),
    ]);
  });

  test("an existing thread keeps its decision when a send names another", async () => {
    const incomingDecisionId = toSafeId<"caseLawDecision">(
      "00000000-0000-0000-0000-000000000007",
    );
    const existingThread = {
      id: threadId,
      title: CHAT_THREAD_PLACEHOLDER_TITLE,
      workspaceId: null,
      contextMatterIds: [],
      dataWorkspaceIds: [],
      webSearchEnabled: false,
      chatModel: null,
      chatReasoningEffort: null,
      rollbackToken: null,
      subjectDecisionId: decisionId,
    };
    const insert = mock(() => ({
      values: async () => await Promise.resolve(),
    }));
    const { safeDb } = createScopedDbMock({
      insert,
      query: {
        chatThreads: {
          findFirst: async () => await Promise.resolve(existingThread),
        },
        chatThreadCompactions: {
          findFirst: async () => await Promise.resolve(null),
        },
      },
      select: () => createSelectQueryMock([]),
      update: () => ({
        set: (values: Partial<typeof chatThreads.$inferInsert>) => ({
          where: async () => {
            Object.assign(existingThread, values);
            await Promise.resolve();
          },
        }),
      }),
    });

    expect(incomingDecisionId).not.toBe(decisionId);
    const result = await loadThread({
      initialDataWorkspaceIds: [],
      initialContextMatterIds: [],
      organizationId,
      recordAuditEvent: async () => await Promise.resolve(),
      safeDb,
      subjectDecisionId: incomingDecisionId,
      threadId,
      title: "Incoming title",
      userId,
      workspaceId: null,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(result).toMatchObject({ value: { type: "existing" } });
    expect(existingThread.title).toBe("Incoming title");
    expect(existingThread.subjectDecisionId).toBe(decisionId);
    expect(insert).not.toHaveBeenCalled();
  });
});
