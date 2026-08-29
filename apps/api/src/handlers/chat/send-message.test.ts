import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_TURN_INTENT } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { chatThreads, chatTurns } from "@/api/db/schema";
import { CHAT_RUN_MODE } from "@/api/handlers/chat/chat-schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import type { PersistableChatMessage } from "./types";
import type { UploadedChatFile } from "./upload-files";

let webSearchProviderLoadHook: (() => void) | undefined;
const loadWebSearchProvidersForOrgMock = mock(async () => {
  webSearchProviderLoadHook?.();
  return {
    urlFetcher: null,
    webSearchProvider: null,
  };
});
const loadOrgKeysModule = await import("@/api/lib/web-search/load-org-keys");
void mock.module("@/api/lib/web-search/load-org-keys", () => ({
  ...loadOrgKeysModule,
  loadWebSearchProvidersForOrg: loadWebSearchProvidersForOrgMock,
}));

const upsertChatThreadSearchDocumentMock = mock(async () => undefined);
void mock.module("@/api/lib/search/index-chat", () => ({
  upsertChatThreadSearchDocument: upsertChatThreadSearchDocumentMock,
}));

const externalMcpToolsModule =
  await import("@/api/handlers/chat/tools/external-mcp-tools");
let externalMcpToolsLoadHook: (() => void) | undefined;
const loadExternalMcpToolsForUserMock = mock(async () => {
  const hook = externalMcpToolsLoadHook;
  if (hook === undefined) {
    throw new Error("Connector discovery must not run after a disconnect");
  }
  externalMcpToolsLoadHook = undefined;
  hook();
  const close = async () => undefined;
  return {
    close,
    connectors: [],
    source: externalMcpToolsModule.createStellaMcpToolSource({
      closeClients: close,
      sourceTools: {},
    }),
    tools: {},
  };
});
void mock.module("@/api/handlers/chat/tools/external-mcp-tools", () => ({
  ...externalMcpToolsModule,
  loadExternalMcpToolsForUser: loadExternalMcpToolsForUserMock,
}));

const chatSideEffectsModule = await import("./send-message-side-effects");
const realRollbackUnpersistedChatSideEffects =
  chatSideEffectsModule.rollbackUnpersistedChatSideEffects;
const uploadMessageFilesWithRollbackMock = mock(
  async ({
    message,
  }: {
    message: PersistableChatMessage;
  }): Promise<
    Result<
      { message: PersistableChatMessage; uploadedFiles: UploadedChatFile[] },
      never
    >
  > => Result.ok({ message, uploadedFiles: [] }),
);
const rollbackUnpersistedChatSideEffectsMock = mock(
  async (
    options: Parameters<
      typeof chatSideEffectsModule.rollbackUnpersistedChatSideEffects
    >[0],
  ) => await realRollbackUnpersistedChatSideEffects(options),
);
void mock.module("./send-message-side-effects", () => ({
  ...chatSideEffectsModule,
  rollbackUnpersistedChatSideEffects: rollbackUnpersistedChatSideEffectsMock,
  uploadMessageFilesWithRollback: uploadMessageFilesWithRollbackMock,
}));

const { default: sendMessage, shouldLoadExternalMcpToolsForStreaming } =
  await import("./send-message");

// The real analytics callbacks run through the handler; only the sink is in
// memory, so no test here ships an event to the provider.
let analytics: RecordingAnalytics;

beforeEach(() => {
  analytics = installRecordingAnalytics();
});

afterEach(() => {
  analytics.restore();
});

type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];
type SendMessageInput = SendMessageCtx["body"]["forwardedProps"];

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");
const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-000000000003");
const messageId = toSafeId<"chatMessage">(
  "00000000-0000-0000-0000-000000000004",
);
const turnId = toSafeId<"chatTurn">("00000000-0000-0000-0000-000000000008");
const activeWorkspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000005",
);
const deletingWorkspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000006",
);
const inaccessibleWorkspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000007",
);

const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
} satisfies OrgAIConfig;

const emptyOrderedRows = () => Object.assign([], { limit: async () => [] });

const selectChatMessages = () => ({
  from: () => ({
    where: () => ({
      for: async () => [],
      limit: async () => [],
      orderBy: emptyOrderedRows,
    }),
  }),
});

const createContext = ({
  contextMatterIds,
  message = {
    id: messageId,
    role: "user",
    parts: [{ type: "text", content: "Summarize the selected matters" }],
  },
  request = new Request("http://localhost/v1/chat/send"),
  onSafeDbTransaction,
  runMode,
  truncateAfterMessageId,
  turnIntent,
  transaction = {
    query: {
      organizationSettings: {
        findFirst: async () => null,
      },
    },
  },
}: {
  contextMatterIds: SendMessageInput["contextMatterIds"];
  message?: SendMessageInput["message"];
  request?: Request;
  onSafeDbTransaction?: (() => void) | undefined;
  runMode?: SendMessageInput["runMode"];
  truncateAfterMessageId?: SendMessageInput["truncateAfterMessageId"];
  turnIntent?: SendMessageInput["turnIntent"];
  transaction?: unknown;
}): SendMessageCtx => {
  const { safeDb, scopedDb } = createScopedDbMock(transaction);
  const observedSafeDb: SafeDb = async (operation, retry) => {
    onSafeDbTransaction?.();
    return await safeDb(operation, retry);
  };

  const forwardedProps = {
    threadId,
    runId: "run-test",
    sendMode: CHAT_SEND_MODE.rawOverride,
    message,
    ...(contextMatterIds === undefined ? {} : { contextMatterIds }),
    ...(truncateAfterMessageId === undefined ? {} : { truncateAfterMessageId }),
    ...(turnIntent === undefined ? {} : { turnIntent }),
    ...(runMode === undefined ? {} : { runMode }),
  };

  return asTestRaw<SendMessageCtx>({
    body: {
      threadId,
      runId: "run-test",
      state: {},
      messages: [message],
      tools: [],
      context: [],
      forwardedProps,
      data: forwardedProps,
    },
    createAuditRecorder: () => async () => {},
    getAccessibleWorkspaces: async () => [
      { id: activeWorkspaceId, status: "active" },
      { id: deletingWorkspaceId, status: "deleting" },
    ],
    getActiveWorkspaceIds: async () => [activeWorkspaceId],
    getWorkspaceAccess: async () => null,
    memberRole: { role: "owner" },
    orgAIConfig,
    pinServerValidatedWorkspaceId: () => false,
    promptCachingEnabled: false,
    recordAuditEvent: async () => {},
    request,
    route: "/v1/chat/send",
    safeDb: observedSafeDb,
    scopedDb,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
  });
};

describe("send message context-matter authorization", () => {
  test("rejects a requested matter outside the caller's accessible set", async () => {
    const result = await sendMessage.handler(
      createContext({ contextMatterIds: [inaccessibleWorkspaceId] }),
    );

    expect(result).toEqual({
      code: 403,
      response: { message: "contextMatterIds includes inaccessible matter" },
    });
  });

  test("treats a deleting matter as inaccessible even when membership still resolves", async () => {
    const result = await sendMessage.handler(
      createContext({ contextMatterIds: [deletingWorkspaceId] }),
    );

    expect(result).toEqual({
      code: 403,
      response: { message: "contextMatterIds includes inaccessible matter" },
    });
  });
});

describe("agent sandbox preflight", () => {
  test("fails before persisting the incoming message when sandbox runs are disabled", async () => {
    const insertValues = mock(async () => undefined);
    const deleteReturning = mock(async () => [{ id: threadId }]);

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        runMode: CHAT_RUN_MODE.agent,
        transaction: {
          delete: () => ({
            where: () => ({ returning: deleteReturning }),
          }),
          insert: () => ({ values: insertValues }),
          query: {
            chatMessages: { findFirst: async () => null },
            chatThreadCompactions: { findFirst: async () => null },
            chatThreads: { findFirst: async () => null },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectChatMessages,
        },
      }),
    );

    expect(result).toEqual({
      code: 422,
      response: {
        message: "Agent sandbox runs are not enabled for this deployment.",
      },
    });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(deleteReturning).toHaveBeenCalledTimes(1);
  });
});

describe("agent connector isolation", () => {
  test("rejects external tool parts without discovering connectors", async () => {
    loadExternalMcpToolsForUserMock.mockClear();

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        message: {
          id: messageId,
          role: "assistant",
          parts: [
            {
              type: "tool-call",
              id: "external-1",
              name: "mcp__test__lookup",
              arguments: "{}",
              input: {},
              state: "input-complete",
            },
          ],
        },
        runMode: CHAT_RUN_MODE.agent,
        transaction: {
          query: {
            chatThreads: { findFirst: async () => null },
            organizationSettings: { findFirst: async () => null },
          },
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid chat message" },
    });
    expect(loadExternalMcpToolsForUserMock).not.toHaveBeenCalled();
  });

  test("does not load external MCP clients for agent streaming", () => {
    expect(shouldLoadExternalMcpToolsForStreaming(CHAT_RUN_MODE.agent)).toBe(
      false,
    );
    expect(shouldLoadExternalMcpToolsForStreaming(undefined)).toBe(true);
  });
});

describe("send message disconnect handling", () => {
  test("treats every thread mutation as rollback ownership adoption", () => {
    const adoptionUpdate = chatThreads.rollbackToken.onUpdateFn?.();
    if (!(adoptionUpdate instanceof SQL)) {
      throw new Error("Expected rollback ownership to have a SQL update hook");
    }

    expect(new PgDialect().sqlToQuery(adoptionUpdate).sql).toBe("null");
  });

  test("does not create a thread when the request is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const insert = mock(() => ({ values: async () => undefined }));

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: { insert },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(insert).not.toHaveBeenCalled();
  });

  test("does not start validation providers after a preflight disconnect", async () => {
    const abortController = new AbortController();
    const findChatThread = mock(async () => {
      abortController.abort();
      return null;
    });
    loadExternalMcpToolsForUserMock.mockClear();
    loadWebSearchProvidersForOrgMock.mockClear();

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        message: {
          id: messageId,
          role: "assistant",
          parts: [{ type: "tool-call", name: "mcp__test__lookup" }],
        },
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          query: {
            chatThreads: { findFirst: findChatThread },
            organizationSettings: { findFirst: async () => null },
          },
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(loadWebSearchProvidersForOrgMock).not.toHaveBeenCalled();
    expect(loadExternalMcpToolsForUserMock).not.toHaveBeenCalled();
  });

  test("does not discover connectors after disconnecting during web provider load", async () => {
    const abortController = new AbortController();
    webSearchProviderLoadHook = () => {
      webSearchProviderLoadHook = undefined;
      abortController.abort();
    };
    loadExternalMcpToolsForUserMock.mockClear();
    loadWebSearchProvidersForOrgMock.mockClear();

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        message: {
          id: messageId,
          role: "assistant",
          parts: [{ type: "tool-call", name: "mcp__test__lookup" }],
        },
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          query: {
            chatThreads: { findFirst: async () => null },
            organizationSettings: { findFirst: async () => null },
          },
        },
      }),
    );
    webSearchProviderLoadHook = undefined;

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(loadWebSearchProvidersForOrgMock).toHaveBeenCalledTimes(1);
    expect(loadExternalMcpToolsForUserMock).not.toHaveBeenCalled();
  });

  test("stops preflight after disconnecting during connector discovery", async () => {
    const abortController = new AbortController();
    externalMcpToolsLoadHook = () => {
      abortController.abort();
    };
    const findChatThread = mock(async () => null);
    loadExternalMcpToolsForUserMock.mockClear();

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        message: {
          id: messageId,
          role: "assistant",
          parts: [{ type: "tool-call", name: "mcp__test__lookup" }],
        },
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          query: {
            chatThreads: { findFirst: findChatThread },
            organizationSettings: { findFirst: async () => null },
          },
        },
      }),
    );
    externalMcpToolsLoadHook = undefined;

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(loadExternalMcpToolsForUserMock).toHaveBeenCalledTimes(1);
    expect(findChatThread).toHaveBeenCalledTimes(1);
  });

  test("deletes an exclusively owned thread when the request aborts during creation", async () => {
    const abortController = new AbortController();
    const insertValues = mock(async () => {
      abortController.abort();
    });
    const deleteReturning = mock(async () => [{ id: threadId }]);

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          delete: () => ({
            where: () => ({ returning: deleteReturning }),
          }),
          insert: () => ({ values: insertValues }),
          query: {
            chatThreads: { findFirst: async () => null },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectChatMessages,
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(deleteReturning).toHaveBeenCalledTimes(1);
  });

  test("preserves a thread whose ownership marker changed before rollback", async () => {
    const abortController = new AbortController();
    const insertValues = mock(async () => {
      abortController.abort();
    });
    const deleteReturning = mock(async () => []);

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          delete: () => ({
            where: () => ({ returning: deleteReturning }),
          }),
          insert: () => ({ values: insertValues }),
          query: {
            chatThreads: { findFirst: async () => null },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectChatMessages,
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(deleteReturning).toHaveBeenCalledTimes(1);
  });

  test("preserves thread recency when adopting rollback ownership", async () => {
    const abortController = new AbortController();
    const claimUpdates: { rollbackToken: null; updatedAt: SQL }[] = [];
    const setClaimValues = mock(
      (values: { rollbackToken: null; updatedAt: SQL }) => {
        claimUpdates.push(values);
        abortController.abort();
        return {
          where: () => ({ returning: async () => [{ id: threadId }] }),
        };
      },
    );
    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          query: {
            chatThreadCompactions: { findFirst: async () => null },
            chatThreads: {
              findFirst: async () => ({
                chatModel: null,
                chatReasoningEffort: null,
                contextMatterIds: [],
                dataWorkspaceIds: [],
                id: threadId,
                messages: [],
                rollbackToken: "pending-rollback",
                title: "Existing thread",
                webSearchEnabled: false,
                workspaceId: null,
              }),
            },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectChatMessages,
          update: () => ({ set: setClaimValues }),
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    const claimUpdate = claimUpdates.at(0);
    if (!claimUpdate) {
      throw new Error("Expected the rollback ownership claim to update");
    }
    expect(claimUpdate.rollbackToken).toBeNull();
    expect(new PgDialect().sqlToQuery(claimUpdate.updatedAt).sql).toContain(
      '"chat_threads"."updated_at"',
    );
  });

  test("does not update existing thread pins after disconnecting during its history read", async () => {
    const abortController = new AbortController();
    const update = mock(() => ({
      set: () => ({ where: async () => undefined }),
    }));
    const selectWithAbort = () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
          orderBy: () => {
            abortController.abort();
            return emptyOrderedRows();
          },
        }),
      }),
    });

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [activeWorkspaceId],
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          query: {
            chatMessages: { findFirst: async () => null },
            chatThreadCompactions: { findFirst: async () => null },
            chatThreads: {
              findFirst: async () => ({
                chatModel: null,
                chatReasoningEffort: null,
                contextMatterIds: [],
                dataWorkspaceIds: [],
                id: threadId,
                messages: [],
                rollbackToken: null,
                title: "Existing thread",
                webSearchEnabled: false,
                workspaceId: null,
              }),
            },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectWithAbort,
          update,
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  test("terminalizes the claimed turn when compaction preflight disconnects", async () => {
    const abortController = new AbortController();
    const turnUpdates: unknown[] = [];
    let turnClaimed = false;
    const selectWithThreadLock = () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
        where: () => ({
          for: async () => [{ id: threadId }],
          limit: async () => [],
          orderBy: emptyOrderedRows,
        }),
      }),
    });
    const insert = (table: unknown) => ({
      values: () =>
        table === chatTurns
          ? {
              onConflictDoNothing: () => ({
                returning: async () => [{ id: turnId }],
              }),
            }
          : undefined,
    });
    const update = (table: unknown) => ({
      set: (values: unknown) => {
        turnUpdates.push(values);
        if (table === chatTurns) {
          if (
            typeof values === "object" &&
            values !== null &&
            "status" in values &&
            values.status === "running"
          ) {
            turnClaimed = true;
          }
          return {
            where: () => ({ returning: async () => [{ id: turnId }] }),
          };
        }
        return { where: async () => undefined };
      },
    });

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          insert,
          query: {
            chatMessages: { findFirst: async () => null },
            // The compaction preflight reads the checkpoint once the turn is
            // claimed (the earlier read belongs to the history window), so
            // disconnecting there lands the abort inside the preflight.
            chatThreadCompactions: {
              findFirst: async () => {
                if (turnClaimed) {
                  abortController.abort();
                }
                return null;
              },
            },
            chatThreads: {
              findFirst: async () => ({
                chatModel: null,
                contextMatterIds: [],
                dataWorkspaceIds: [],
                id: threadId,
                messages: [],
                rollbackToken: null,
                title: "Existing thread",
                webSearchEnabled: false,
                workspaceId: null,
              }),
            },
            chatTurns: {
              findFirst: async ({
                where,
              }: {
                where?: { status?: { eq?: string } };
              }) =>
                where?.status?.eq === "running" ? undefined : { id: turnId },
            },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectWithThreadLock,
          update,
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(turnUpdates).toContainEqual(
      expect.objectContaining({
        interruptionReason: "client-disconnected",
        status: "interrupted",
      }),
    );
  });

  test("terminalizes the claimed turn when context preparation disconnects", async () => {
    const abortController = new AbortController();
    let safeDbTransaction = 0;
    let acceptanceTransaction: number | null = null;
    let claimTransaction: number | null = null;
    let organizationSettingsReads = 0;
    const findOrganizationSettings = mock(async () => {
      organizationSettingsReads += 1;
      if (organizationSettingsReads === 2) {
        abortController.abort();
      }
      return null;
    });
    const turnUpdates: unknown[] = [];
    const selectWithThreadLock = () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
        where: () => ({
          for: async () => [{ id: threadId }],
          limit: async () => [],
          orderBy: emptyOrderedRows,
        }),
      }),
    });
    const insert = (table: unknown) => ({
      values: () => {
        if (table !== chatTurns) {
          return undefined;
        }
        acceptanceTransaction = safeDbTransaction;
        return {
          onConflictDoNothing: () => ({
            returning: async () => [{ id: turnId }],
          }),
        };
      },
    });
    const update = (table: unknown) => ({
      set: (values: unknown) => {
        turnUpdates.push(values);
        if (table === chatTurns) {
          if (
            typeof values === "object" &&
            values !== null &&
            "status" in values &&
            values.status === "running"
          ) {
            claimTransaction = safeDbTransaction;
          }
          return {
            where: () => ({ returning: async () => [{ id: turnId }] }),
          };
        }
        return { where: async () => undefined };
      },
    });

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        onSafeDbTransaction: () => {
          safeDbTransaction += 1;
        },
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          insert,
          query: {
            chatMessages: { findFirst: async () => null },
            chatThreadCompactions: { findFirst: async () => null },
            chatThreads: {
              findFirst: async () => ({
                chatModel: null,
                contextMatterIds: [],
                dataWorkspaceIds: [],
                id: threadId,
                messages: [],
                rollbackToken: null,
                title: "Existing thread",
                webSearchEnabled: false,
                workspaceId: null,
              }),
            },
            chatTurns: {
              findFirst: async ({
                where,
              }: {
                where?: { status?: { eq?: string } };
              }) =>
                where?.status?.eq === "running" ? undefined : { id: turnId },
            },
            organizationSettings: { findFirst: findOrganizationSettings },
          },
          select: selectWithThreadLock,
          update,
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(findOrganizationSettings).toHaveBeenCalledTimes(2);
    expect(acceptanceTransaction).not.toBeNull();
    expect(claimTransaction).toBe(acceptanceTransaction);
    expect(turnUpdates).toContainEqual(
      expect.objectContaining({
        interruptionReason: "client-disconnected",
        status: "interrupted",
      }),
    );
  });

  test("persists a reloadable assistant error when connector preflight fails", async () => {
    const insertedMessages: unknown[] = [];
    const turnUpdates: unknown[] = [];
    const selectWithThreadLock = () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
        where: () => ({
          for: async () => [{ id: threadId }],
          limit: async () => [],
          orderBy: emptyOrderedRows,
        }),
      }),
    });
    const insert = (table: unknown) => ({
      values: (values: unknown) => {
        if (table === chatTurns) {
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: turnId }],
            }),
          };
        }
        insertedMessages.push(values);
        return undefined;
      },
    });
    const update = (table: unknown) => ({
      set: (values: unknown) => {
        if (table === chatTurns) {
          turnUpdates.push(values);
          return {
            where: () => ({ returning: async () => [{ id: turnId }] }),
          };
        }
        return { where: async () => undefined };
      },
    });

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        transaction: {
          insert,
          query: {
            chatMessages: { findFirst: async () => null },
            chatThreadCompactions: { findFirst: async () => null },
            chatThreads: {
              findFirst: async () => ({
                chatModel: null,
                contextMatterIds: [],
                dataWorkspaceIds: [],
                id: threadId,
                messages: [],
                rollbackToken: null,
                title: "Existing thread",
                webSearchEnabled: false,
                workspaceId: null,
              }),
            },
            chatTurns: {
              findFirst: async ({
                where,
              }: {
                where?: { status?: { eq?: string } };
              }) =>
                where?.status?.eq === "running" ? undefined : { id: turnId },
            },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectWithThreadLock,
          update,
        },
      }),
    );

    expect(result).toEqual({
      code: 500,
      response: { message: "Failed to discover chat connectors" },
    });
    const persistedFailure = insertedMessages.at(-1);
    expect(persistedFailure).toEqual([
      expect.objectContaining({
        content: expect.objectContaining({
          data: [],
          metadata: { turnOutcome: { error: "unknown", type: "failed" } },
        }),
        role: "assistant",
      }),
    ]);
    expect(turnUpdates).toContainEqual(
      expect.objectContaining({
        failureCode: "connector-discovery",
        failureRetryable: true,
        status: "failed",
      }),
    );
    // The 500 is reported once, carrying the wrapper and the underlying
    // failure structurally — no message reaches the sink.
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        "error.cause.class": "Error",
        "error.class": "HandlerError",
        route: "/v1/chat/send",
      },
    ]);
  });

  test("stops before connector discovery when the client disconnects during persistence", async () => {
    const abortController = new AbortController();
    const insertValues = mock(() => ({
      onConflictDoNothing: () => ({
        returning: async () => [{ id: turnId }],
      }),
    }));
    const updateWhere = mock(async () => {
      abortController.abort();
    });
    const selectWithThreadLock = () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
        where: () => ({
          for: async () => [{ id: threadId }],
          limit: async () => [],
          orderBy: emptyOrderedRows,
        }),
      }),
    });
    loadExternalMcpToolsForUserMock.mockClear();
    upsertChatThreadSearchDocumentMock.mockClear();

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        request: new Request("http://localhost/v1/chat/send", {
          signal: abortController.signal,
        }),
        transaction: {
          insert: () => ({ values: insertValues }),
          query: {
            chatMessages: { findFirst: async () => null },
            chatThreadCompactions: { findFirst: async () => null },
            chatTurns: {
              findFirst: async ({
                where,
              }: {
                where?: { status?: unknown };
              }) => {
                const status = where?.status;
                const queriedStatus =
                  typeof status === "object" &&
                  status !== null &&
                  "eq" in status
                    ? status.eq
                    : undefined;
                return queriedStatus === "running" ? undefined : { id: turnId };
              },
            },
            chatThreads: {
              findFirst: async () => ({
                chatModel: null,
                contextMatterIds: [],
                dataWorkspaceIds: [],
                id: threadId,
                messages: [],
                rollbackToken: null,
                title: "Existing thread",
                webSearchEnabled: false,
                workspaceId: null,
              }),
            },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectWithThreadLock,
          update: (table: unknown) => {
            if (table === chatThreads) {
              return { set: () => ({ where: updateWhere }) };
            }
            if (table === chatTurns) {
              return {
                set: () => ({
                  where: () => ({ returning: async () => [{ id: turnId }] }),
                }),
              };
            }
            throw new Error("Unexpected table update in chat send test");
          },
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before stream started" },
    });
    // Turn acceptance, the user message, and the terminal interrupted
    // assistant message each persist their own row; the user-message
    // persist and the interrupt persist each touch the thread row once.
    expect(insertValues).toHaveBeenCalledTimes(3);
    expect(updateWhere).toHaveBeenCalledTimes(2);
    expect(upsertChatThreadSearchDocumentMock).toHaveBeenCalledWith(threadId);
    expect(loadExternalMcpToolsForUserMock).not.toHaveBeenCalled();
  });
});

describe("send message turn persistence", () => {
  test("rolls back an uploaded attachment before rejecting an invalid replay", async () => {
    const uploadedFile = {
      id: toSafeId<"userFile">("00000000-0000-0000-0000-000000000009"),
      s3Key: "chat/thread/input.png",
      thumbnailS3Key: "chat/thread/input-thumbnail.png",
    } satisfies UploadedChatFile;
    uploadMessageFilesWithRollbackMock.mockImplementationOnce(
      async ({ message }) =>
        Result.ok({ message, uploadedFiles: [uploadedFile] }),
    );
    rollbackUnpersistedChatSideEffectsMock.mockClear();
    rollbackUnpersistedChatSideEffectsMock.mockImplementationOnce(async () =>
      Result.ok(),
    );

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        truncateAfterMessageId: messageId,
        turnIntent: CHAT_TURN_INTENT.regenerate,
        transaction: {
          query: {
            chatThreadCompactions: { findFirst: async () => null },
            chatThreads: {
              findFirst: async () => ({
                chatModel: null,
                chatReasoningEffort: null,
                contextMatterIds: [],
                dataWorkspaceIds: [],
                id: threadId,
                messages: [],
                rollbackToken: null,
                title: "Existing thread",
                webSearchEnabled: false,
                workspaceId: null,
              }),
            },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectChatMessages,
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message: "Regeneration requires one unambiguous user-message target",
      },
    });
    expect(rollbackUnpersistedChatSideEffectsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        uploadedFiles: [uploadedFile],
      }),
    );
  });

  test("rolls back every uploaded file when a running turn rejects the message", async () => {
    const uploadedFile = {
      id: toSafeId<"userFile">("00000000-0000-0000-0000-000000000009"),
      s3Key: "chat/thread/input.png",
      thumbnailS3Key: "chat/thread/input-thumbnail.png",
    } satisfies UploadedChatFile;
    uploadMessageFilesWithRollbackMock.mockImplementationOnce(
      async ({ message }) =>
        Result.ok({ message, uploadedFiles: [uploadedFile] }),
    );
    rollbackUnpersistedChatSideEffectsMock.mockClear();
    rollbackUnpersistedChatSideEffectsMock.mockImplementationOnce(async () =>
      Result.ok(),
    );
    // The history window reads the compaction checkpoint once while
    // hydrating the thread; the compaction preflight would read it again.
    // A rejected send must stop before that second read, i.e. before any
    // metered AI work.
    const HISTORY_WINDOW_CHECKPOINT_READS = 1;
    let compactionCheckpointReads = 0;

    const selectWithThreadLock = () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
        where: () => ({
          for: async () => [{ id: threadId }],
          limit: async () => [],
          orderBy: emptyOrderedRows,
        }),
      }),
    });

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        transaction: {
          query: {
            chatMessages: { findFirst: async () => null },
            chatThreadCompactions: {
              findFirst: async () => {
                compactionCheckpointReads += 1;
                return null;
              },
            },
            chatThreads: {
              findFirst: async () => ({
                chatModel: null,
                contextMatterIds: [],
                dataWorkspaceIds: [],
                id: threadId,
                messages: [],
                rollbackToken: null,
                title: "Existing thread",
                webSearchEnabled: false,
                workspaceId: null,
              }),
            },
            chatTurns: { findFirst: async () => ({ id: turnId }) },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectWithThreadLock,
          update: () => ({ set: () => ({ where: async () => [] }) }),
        },
      }),
    );

    expect(result).toEqual({
      code: 409,
      response: { message: "A chat turn is already running" },
    });
    expect(compactionCheckpointReads).toBe(HISTORY_WINDOW_CHECKPOINT_READS);
    expect(rollbackUnpersistedChatSideEffectsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        uploadedFiles: [uploadedFile],
      }),
    );
  });
});
