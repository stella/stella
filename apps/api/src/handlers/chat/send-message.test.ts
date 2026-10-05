import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_TURN_INTENT } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatRunLogs,
  chatThreadNames,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { toPersistableChatMessage } from "@/api/handlers/chat/chat-message-parts";
import { CHAT_RUN_MODE } from "@/api/handlers/chat/chat-schema";
import { processChatTurnOwnership } from "@/api/handlers/chat/chat-turn-run";
import {
  ChatSendLifecycle,
  createSendMessage,
  shouldLoadExternalMcpToolsForStreaming,
} from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import * as chatSideEffectsModule from "@/api/handlers/chat/send-message-side-effects";
import { streamChat } from "@/api/handlers/chat/stream-chat";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { CHAT_THREAD_NAME_KIND } from "@/api/lib/chat/thread-name-kinds";
import { HandlerError, DatabaseError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  actionAdmissionRefusal,
  type ActionAdmissionError,
} from "@/api/lib/rate-limit/action-admission";
import type { AdmittedActionIdentity } from "@/api/lib/rate-limit/action-kinds";
import { actionAdmissionErrorFor } from "@/api/tests/helpers/action-admission-error";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import { testFileKey } from "@/api/tests/helpers/file-key";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import type {
  PersistableChatMessage,
  PersistableTerminalAssistantMessage,
} from "./types";
import type { UploadedChatFile } from "./upload-files";

let webSearchProviderLoadHook: (() => void) | undefined;
const loadWebSearchProvidersForOrgMock = mock(async () => {
  webSearchProviderLoadHook?.();
  return {
    urlFetcher: null,
    webSearchProvider: null,
  };
});
const upsertChatThreadSearchDocumentMock = mock(async () => undefined);
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
const compactMessagesForContextMock = mock(compactMessagesForContext);
const sendMessage = createSendMessage({
  compactMessagesForContext: compactMessagesForContextMock,
  createRefRegistry: createChatRefRegistry,
  indexThread: upsertChatThreadSearchDocumentMock,
  loadExternalMcpTools: loadExternalMcpToolsForUserMock,
  loadWebSearchProviders: loadWebSearchProvidersForOrgMock,
  rollbackSideEffects: rollbackUnpersistedChatSideEffectsMock,
  streamResponse: streamChat,
  uploadMessageFiles: uploadMessageFilesWithRollbackMock,
});

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
  decision: null,
} satisfies OrgAIConfig;

const emptyOrderedRows = () => Object.assign([], { limit: async () => [] });
const startedThreadNames = [
  { kind: CHAT_THREAD_NAME_KIND.ledgerStart, name: "", target: null },
];

const selectChatMessages = () => ({
  from: (table: unknown) =>
    table === chatThreadNames
      ? { where: async () => startedThreadNames }
      : {
          where: () => ({
            for: async () => [],
            limit: async () => [],
            orderBy: emptyOrderedRows,
          }),
        },
});

const withThreadNameReads = (select: () => { from: () => unknown }) => () => ({
  from: (table: unknown) =>
    table === chatThreadNames
      ? { where: async () => startedThreadNames }
      : select().from(),
});

// Settlement closes the turn's run log in the transaction that ends the turn.
const withRunLogInsert =
  (insert: (table: unknown) => unknown) => (table: unknown) =>
    table === chatRunLogs
      ? { values: () => ({ onConflictDoNothing: async () => undefined }) }
      : insert(table);

const withRunLogUpdate =
  (update: (table: unknown) => unknown) => (table: unknown) =>
    table === chatRunLogs
      ? { set: () => ({ where: async () => undefined }) }
      : update(table);

const withRegistryCredentialQuery = (transaction: unknown): unknown => {
  if (typeof transaction !== "object" || transaction === null) {
    return transaction;
  }
  const query = "query" in transaction ? transaction.query : undefined;
  return {
    execute: async (statement: SQL) => {
      if (
        !new PgDialect()
          .sqlToQuery(statement)
          .sql.includes("chat_turn_run_id_taken")
      ) {
        throw new Error("Unexpected SQL execution in chat send test");
      }
      return { rows: [{ taken: false }] };
    },
    ...transaction,
    select: (selection: unknown) => {
      if (
        typeof selection === "object" &&
        selection !== null &&
        "emailVerified" in selection
      ) {
        return {
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: async () => [
                  { email: "member@example.test", emailVerified: true },
                ],
              }),
            }),
          }),
        };
      }
      if ("select" in transaction && typeof transaction.select === "function") {
        const result: unknown = Reflect.apply(transaction.select, transaction, [
          selection,
        ]);
        return result;
      }
      return selectChatMessages();
    },
    query: {
      businessRegistryCredentials: { findMany: async () => [] },
      ...(typeof query === "object" && query !== null ? query : {}),
    },
  };
};

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
  const { safeDb, scopedDb } = createScopedDbMock(
    withRegistryCredentialQuery(transaction),
  );
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
    memberRole: sessionMemberRole("owner"),
    orgAIConfig,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
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
            chatThreads: { findFirst: async () => undefined },
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
            chatThreads: { findFirst: async () => undefined },
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
  test("tracks a preflight claim until settlement and rollback finish", async () => {
    for (const settlementFails of [false, true]) {
      const settlementStarted = Promise.withResolvers<undefined>();
      const finishSettlement =
        Promise.withResolvers<Result<boolean, DatabaseError>>();
      const rollbackStarted = Promise.withResolvers<undefined>();
      const finishRollback = Promise.withResolvers<undefined>();
      let calls = 0;
      const safeDb = asTestRaw<SafeDb>(async () => {
        calls += 1;
        if (calls === 1) {
          settlementStarted.resolve(undefined);
          return await finishSettlement.promise;
        }
        return Result.ok("owned");
      });
      const lifecycle = new ChatSendLifecycle({
        mode: "raw",
        indexThread: upsertChatThreadSearchDocumentMock,
        externalMcpToolsLoader:
          externalMcpToolsModule.createLazyExternalMcpToolsLoader(async () => {
            throw new Error("Connector discovery was not expected");
          }),
        recordAuditEvent: async () => undefined,
        rollbackSideEffects: async () => {
          rollbackStarted.resolve(undefined);
          await finishRollback.promise;
          return Result.ok(undefined);
        },
        safeDb,
        scopedDb: createScopedDbMock({}).scopedDb,
        threadId,
        userId,
        workspaceId: activeWorkspaceId,
      });
      lifecycle.claimTurn(
        { executionId: Bun.randomUUIDv7(), id: turnId },
        undefined,
      );
      lifecycle.adoptThread(
        asTestRaw<Parameters<ChatSendLifecycle["adoptThread"]>[0]>({}),
      );
      const cleanup = lifecycle.cleanup();
      await settlementStarted.promise;
      const relinquishing = processChatTurnOwnership.relinquish();
      const finishedEarly = await Promise.race([
        relinquishing.then(() => true),
        Bun.sleep(20).then(() => false),
      ]);
      expect(finishedEarly).toBe(false);
      finishSettlement.resolve(
        settlementFails
          ? Result.err(new DatabaseError({ message: "settlement failed" }))
          : Result.ok(true),
      );
      await rollbackStarted.promise;
      const finishedDuringRollback = await Promise.race([
        relinquishing.then(() => true),
        Bun.sleep(20).then(() => false),
      ]);
      expect(finishedDuringRollback).toBe(false);
      finishRollback.resolve(undefined);
      await cleanup;
      expect(await relinquishing).toBe("stored");
    }
  });

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
      return undefined;
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
            chatThreads: { findFirst: async () => undefined },
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
    const findChatThread = mock(async () => undefined);
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
            chatThreads: { findFirst: async () => undefined },
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
            chatThreads: { findFirst: async () => undefined },
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
          select: withThreadNameReads(selectWithAbort),
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
                returning: async () => [
                  { id: turnId, cancelRequestedAt: null },
                ],
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
            where: () => ({
              returning: async () => [{ id: turnId, cancelRequestedAt: null }],
            }),
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
          insert: withRunLogInsert(insert),
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
          select: withThreadNameReads(selectWithThreadLock),
          update: withRunLogUpdate(update),
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
            returning: async () => [{ id: turnId, cancelRequestedAt: null }],
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
            where: () => ({
              returning: async () => [{ id: turnId, cancelRequestedAt: null }],
            }),
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
          insert: withRunLogInsert(insert),
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
          select: withThreadNameReads(selectWithThreadLock),
          update: withRunLogUpdate(update),
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
              returning: async () => [{ id: turnId, cancelRequestedAt: null }],
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
            where: () => ({
              returning: async () => [{ id: turnId, cancelRequestedAt: null }],
            }),
          };
        }
        return { where: async () => undefined };
      },
    });

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        transaction: {
          insert: withRunLogInsert(insert),
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
          select: withThreadNameReads(selectWithThreadLock),
          update: withRunLogUpdate(update),
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

  test("rejects a taken run id before metered context compaction", async () => {
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
      values: () =>
        table === chatTurns
          ? {
              onConflictDoNothing: () => ({
                returning: async () => [
                  { id: turnId, cancelRequestedAt: null },
                ],
              }),
            }
          : undefined,
    });
    const update = (table: unknown) => ({
      set: (values: unknown) => {
        if (table === chatTurns) {
          turnUpdates.push(values);
          return {
            where: () => ({
              returning: async () => [{ id: turnId, cancelRequestedAt: null }],
            }),
          };
        }
        return { where: async () => undefined };
      },
    });
    const lookup = mock(async (statement: SQL) => {
      expect(new PgDialect().sqlToQuery(statement).sql).toContain(
        "chat_turn_run_id_taken",
      );
      return { rows: [{ taken: true }] };
    });
    compactMessagesForContextMock.mockClear();
    loadExternalMcpToolsForUserMock.mockClear();

    const result = await sendMessage.handler(
      createContext({
        contextMatterIds: [],
        transaction: {
          execute: lookup,
          insert: withRunLogInsert(insert),
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
          select: withThreadNameReads(selectWithThreadLock),
          update: withRunLogUpdate(update),
        },
      }),
    );

    expect(result).toEqual({
      code: 409,
      response: { message: "The run id already names another chat turn" },
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(compactMessagesForContextMock).not.toHaveBeenCalled();
    expect(loadExternalMcpToolsForUserMock).not.toHaveBeenCalled();
    expect(turnUpdates).toContainEqual(
      expect.objectContaining({
        failureCode: "internal",
        failureRetryable: false,
        status: "failed",
      }),
    );
  });

  const refusalReasons = {
    busy: "busy",
    period_exhausted: "period_exhausted",
    daily_exhausted: "daily_exhausted",
    not_enabled: "not_enabled",
    not_on_plan: "not_on_plan",
    unavailable: "unavailable",
  } as const satisfies { [Reason in ActionAdmissionError["reason"]]: Reason };
  for (const reason of Object.values(refusalReasons)) {
    for (const phase of ["period", "context", "dispatch"] as const) {
      test(`${reason} ${phase} phase persists its canonical outcome before any provider work`, async () => {
        const refusal = actionAdmissionRefusal(
          actionAdmissionErrorFor(reason, "Admission refused"),
        );
        const admission = new AbortController();
        const loseAdmission = () =>
          admission.abort(actionAdmissionErrorFor(reason, "Admission refused"));
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
          values: () =>
            table === chatTurns
              ? {
                  onConflictDoNothing: () => ({
                    returning: async () => [
                      { id: turnId, cancelRequestedAt: null },
                    ],
                  }),
                }
              : undefined,
        });
        const update = (table: unknown) => ({
          set: (values: unknown) => {
            if (table === chatTurns) {
              turnUpdates.push(values);
              if (
                phase === "dispatch" &&
                typeof values === "object" &&
                values !== null &&
                "leaseExpiresAt" in values &&
                "runId" in values
              ) {
                loseAdmission();
              }
              return {
                where: () => ({
                  returning: async () => [
                    { id: turnId, cancelRequestedAt: null },
                  ],
                }),
              };
            }
            return { where: async () => undefined };
          },
        });
        const lookup = mock(async (statement: SQL) => {
          expect(new PgDialect().sqlToQuery(statement).sql).toContain(
            "chat_turn_run_id_taken",
          );
          return { rows: [{ taken: false }] };
        });
        compactMessagesForContextMock.mockClear();
        loadExternalMcpToolsForUserMock.mockClear();

        let acquisitions = 0;
        let releases = 0;
        const insertedMessages: unknown[] = [];
        const loadTools = mock(async () => {
          if (phase === "context") {
            loseAdmission();
          }
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
        const refusedSend = createSendMessage({
          compactMessagesForContext: compactMessagesForContextMock,
          createRefRegistry: createChatRefRegistry,
          indexThread: upsertChatThreadSearchDocumentMock,
          loadExternalMcpTools: loadTools,
          loadWebSearchProviders: loadWebSearchProvidersForOrgMock,
          rollbackSideEffects: rollbackUnpersistedChatSideEffectsMock,
          streamResponse: streamChat,
          uploadMessageFiles: uploadMessageFilesWithRollbackMock,
          startAdmission: async (options) => {
            expect(options.mode).toBe("concurrency-only");
            acquisitions += 1;
            return Result.ok({
              signal: admission.signal,
              release: async () => {
                releases += 1;
              },
              modelAdmission: testModelAdmission(options.organizationId),
              reservePeriod: async (identity: AdmittedActionIdentity) => {
                expect(turnUpdates).toContainEqual({ runId: "run-test" });
                expect(identity).toEqual({
                  actionKind: "chat.send",
                  logicalPhaseId: JSON.stringify([turnId, "run-test"]),
                });
                if (phase !== "period") {
                  return Result.ok(undefined);
                }
                return Result.err(
                  new HandlerError({
                    ...refusal,
                  }),
                );
              },
            });
          },
        });
        const result = await refusedSend.handler(
          createContext({
            contextMatterIds: [],
            transaction: {
              execute: lookup,
              insert: withRunLogInsert((table) => {
                const original = insert(table);
                return {
                  values: (values: unknown) => {
                    if (table === chatMessages) {
                      insertedMessages.push(values);
                    }
                    return original.values();
                  },
                };
              }),
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
                    where?.status?.eq === "running"
                      ? undefined
                      : { id: turnId },
                },
                organizationSettings: { findFirst: async () => null },
              },
              select: withThreadNameReads(selectWithThreadLock),
              update: withRunLogUpdate(update),
            },
          }),
        );

        expect(result).toEqual({
          code: refusal.status,
          response: {
            message: refusal.message,
            code: refusal.code,
            retryable: refusal.retryable,
            hint: refusal.hint,
            ...(refusal.contactUrl === undefined
              ? {}
              : { contactUrl: refusal.contactUrl }),
          },
        });
        expect(acquisitions).toBe(1);
        expect(releases).toBe(1);
        expect(insertedMessages).toHaveLength(2);
        const stored = structuredClone(insertedMessages).flat();
        expect(stored).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: expect.objectContaining({
              metadata: expect.objectContaining({
                turnOutcome: { type: "failed", error: "unknown", refusal },
              }),
            }),
          }),
        );
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(loadTools).toHaveBeenCalledTimes(phase === "period" ? 0 : 1);
        expect(turnUpdates).toContainEqual(
          expect.objectContaining({
            failureCode: "boundary-refusal",
            failureRetryable: false,
            status: "failed",
          }),
        );
      });
    }
  }

  test("stops before connector discovery when the client disconnects during persistence", async () => {
    const abortController = new AbortController();
    const insertValues = mock(() => ({
      onConflictDoNothing: () => ({
        returning: async () => [{ id: turnId, cancelRequestedAt: null }],
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
          insert: withRunLogInsert(() => ({ values: insertValues })),
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
          select: withThreadNameReads(selectWithThreadLock),
          update: withRunLogUpdate((table: unknown) => {
            if (table === chatThreads) {
              return { set: () => ({ where: updateWhere }) };
            }
            if (table === chatTurns) {
              return {
                set: () => ({
                  where: () => ({
                    returning: async () => [
                      { id: turnId, cancelRequestedAt: null },
                    ],
                  }),
                }),
              };
            }
            throw new Error("Unexpected table update in chat send test");
          }),
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
      s3Key: testFileKey("chat/thread/input.png"),
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
      s3Key: testFileKey("chat/thread/input.png"),
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
          select: withThreadNameReads(selectWithThreadLock),
          update: () => ({
            set: () => ({
              where: () => ({ returning: async () => [] }),
            }),
          }),
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

describe("assistant turn settlement", () => {
  type StreamChatProps = Parameters<typeof streamChat>[0];
  const assistantMessageId = toSafeId<"chatMessage">(
    "00000000-0000-0000-0000-00000000000a",
  );
  const completedMessage = (
    parts: PersistableChatMessage["parts"],
  ): PersistableTerminalAssistantMessage => ({
    ...toPersistableChatMessage({
      id: assistantMessageId,
      parts,
      role: "assistant",
    }),
    metadata: { turnOutcome: { type: "completed" } },
    role: "assistant",
  });
  const isAssistantRow = (values: unknown) =>
    Array.isArray(values) &&
    values.some(
      (row: unknown) =>
        typeof row === "object" &&
        row !== null &&
        "role" in row &&
        row.role === "assistant",
    );

  /**
   * Runs a send up to the provider dispatch, which is mocked to hand back the
   * stream's `onFinish` callback instead of streaming, so a test can drive
   * the settlement path with a chosen response message and fault.
   */
  const startStreamingTurn = async ({
    failAssistantInsertOnce = false,
    onSafeDbTransaction,
  }: {
    failAssistantInsertOnce?: boolean;
    onSafeDbTransaction?: (() => void) | undefined;
  } = {}) => {
    let onFinish: StreamChatProps["onFinish"] | undefined;
    const turnUpdates: unknown[] = [];
    const streamResponse = mock(async (props: StreamChatProps) => {
      onFinish = props.onFinish;
      return {
        type: "streaming",
        response: new Response("", {
          headers: { "content-type": "text/event-stream" },
        }),
      } as const;
    });
    const send = createSendMessage({
      compactMessagesForContext: compactMessagesForContextMock,
      createRefRegistry: createChatRefRegistry,
      indexThread: upsertChatThreadSearchDocumentMock,
      loadExternalMcpTools: loadExternalMcpToolsForUserMock,
      loadWebSearchProviders: loadWebSearchProvidersForOrgMock,
      rollbackSideEffects: rollbackUnpersistedChatSideEffectsMock,
      streamResponse,
      uploadMessageFiles: uploadMessageFilesWithRollbackMock,
    });
    externalMcpToolsLoadHook = () => {};
    let assistantInsertsFailed = 0;
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
              returning: async () => [{ id: turnId, cancelRequestedAt: null }],
            }),
          };
        }
        if (
          table === chatMessages &&
          failAssistantInsertOnce &&
          assistantInsertsFailed === 0 &&
          isAssistantRow(values)
        ) {
          assistantInsertsFailed += 1;
          throw new Error("chat_messages insert failed");
        }
        return undefined;
      },
    });
    const update = (table: unknown) => ({
      set: (values: unknown) => {
        if (table === chatTurns) {
          turnUpdates.push(values);
          return {
            where: () => ({
              returning: async () => [{ cancelRequestedAt: null, id: turnId }],
            }),
          };
        }
        return { where: async () => undefined };
      },
    });

    const result = await send.handler(
      createContext({
        contextMatterIds: [],
        onSafeDbTransaction,
        transaction: {
          insert: withRunLogInsert(insert),
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
          select: withThreadNameReads(selectWithThreadLock),
          update: withRunLogUpdate(update),
        },
      }),
    );
    expect(streamResponse).toHaveBeenCalledTimes(1);
    if (onFinish === undefined) {
      throw new Error(
        `the send did not reach streaming: ${JSON.stringify(result)}`,
      );
    }
    return { onFinish, turnUpdates };
  };

  /** The rejection `onFinish` reports to the stream, captured as a value. */
  const settlementFailure = async (
    settle: Promise<unknown>,
  ): Promise<unknown> => {
    const settled = await Result.tryPromise({
      try: async () => await settle,
      catch: (cause) => cause,
    });
    return Result.isError(settled) ? settled.error : undefined;
  };

  const failedTurnUpdate = (failureCode: string) =>
    expect.objectContaining({
      failureCode,
      failureRetryable: true,
      status: "failed",
    });

  test("fails the turn when the generated tool parts do not validate", async () => {
    const { onFinish, turnUpdates } = await startStreamingTurn();
    const input = {
      analysis: "The side is not in the request.",
      questions: [{ question: "Which side are you on?", reason: "Tiers." }],
    };

    expect(
      await settlementFailure(
        onFinish({
          outcome: { type: "completed" },
          responseMessage: completedMessage([
            {
              // The text names a different call than the input: the
              // canonical-input check rejects the part.
              arguments: JSON.stringify({ ...input, analysis: "Which law?" }),
              id: "call-drifted",
              input,
              name: "ask-user",
              state: "input-complete",
              type: "tool-call",
            },
          ]),
        }),
      ),
    ).toMatchObject({
      message: "Generated chat tool parts are invalid",
      status: 500,
    });
    expect(turnUpdates).toContainEqual(failedTurnUpdate("persistence"));
  });

  test("fails the turn as a persistence failure when the assistant message cannot be written", async () => {
    const { onFinish, turnUpdates } = await startStreamingTurn({
      failAssistantInsertOnce: true,
    });

    expect(
      await settlementFailure(
        onFinish({
          outcome: { type: "completed" },
          responseMessage: completedMessage([
            { content: "Done.", type: "text" },
          ]),
        }),
      ),
    ).toMatchObject({
      message: "Failed to persist assistant turn",
      status: 500,
    });
    expect(turnUpdates).toContainEqual(failedTurnUpdate("persistence"));
  });

  test("fails the turn when settlement throws instead of returning", async () => {
    let explodeNextTransaction = false;
    const { onFinish, turnUpdates } = await startStreamingTurn({
      onSafeDbTransaction: () => {
        if (!explodeNextTransaction) {
          return;
        }
        explodeNextTransaction = false;
        throw new Error("connection reset");
      },
    });
    explodeNextTransaction = true;

    expect(
      await settlementFailure(
        onFinish({
          outcome: { type: "completed" },
          responseMessage: completedMessage([
            { content: "Done.", type: "text" },
          ]),
        }),
      ),
    ).toMatchObject({
      cause: expect.objectContaining({ message: "connection reset" }),
      message: "Failed to settle assistant turn",
      status: 500,
    });
    expect(turnUpdates).toContainEqual(failedTurnUpdate("internal"));
  });

  test("keeps a completed turn completed when a follow-up throws", async () => {
    let turnCompleted = (): boolean => false;
    let followUpFailures = 0;
    const { onFinish, turnUpdates } = await startStreamingTurn({
      // The first transaction after the turn row reads completed is a
      // follow-up's (the compaction mark), never the turn's settlement.
      onSafeDbTransaction: () => {
        if (!turnCompleted() || followUpFailures > 0) {
          return;
        }
        followUpFailures += 1;
        throw new Error("compaction mark failed");
      },
    });
    turnCompleted = () =>
      turnUpdates.some(
        (update) =>
          typeof update === "object" &&
          update !== null &&
          "status" in update &&
          update.status === "completed",
      );
    // Long enough to cross any model's compaction trigger, so the follow-up
    // writes the compaction mark.
    const longReply = Array.from({ length: 128 }, (_, index) => ({
      content: `${String(index)} ${"clause ".repeat(1200)}`,
      type: "text" as const,
    }));

    const failure = await settlementFailure(
      onFinish({
        outcome: { type: "completed" },
        responseMessage: completedMessage(longReply),
      }),
    );

    // The fixture reached the fault: the follow-up's write threw.
    expect(followUpFailures).toBe(1);
    // The stored completion stays the turn's outcome.
    const violations = violationsOf(
      CHAT_ORACLE.persistedTurnOutcome,
      turnUpdates.filter(
        (update) =>
          typeof update === "object" &&
          update !== null &&
          "status" in update &&
          update.status === "failed",
      ),
    );
    if (violations.length > 0) {
      panic(`The turn breaks an invariant: ${JSON.stringify(violations)}`);
    }
    expect(turnUpdates).toContainEqual(
      expect.objectContaining({ status: "completed" }),
    );
    expect(failure).toBeUndefined();
  });
});
