import { describe, expect, mock, test } from "bun:test";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import { chatThreads } from "@/api/db/schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

void mock.module("@/api/lib/web-search/load-org-keys", () => ({
  loadWebSearchProvidersForOrg: async () => ({
    urlFetcher: null,
    webSearchProvider: null,
  }),
}));

let analyticsCreationHook: (() => void) | undefined;
void mock.module("@/api/lib/analytics/tanstack-ai", () => ({
  createTanStackAIAnalyticsCallbacks: () => {
    analyticsCreationHook?.();
    return {
      captureError: () => undefined,
      middleware: [],
    };
  },
}));

const sendMessage = (await import("./send-message")).default;

type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");
const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-000000000003");
const messageId = toSafeId<"chatMessage">(
  "00000000-0000-0000-0000-000000000004",
);
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

const emptyOrderedRows = () =>
  Object.assign(Promise.resolve([]), { limit: async () => [] });

const selectChatMessages = () => ({
  from: () => ({
    where: () => ({ orderBy: emptyOrderedRows }),
  }),
});

const createContext = ({
  contextMatterIds,
  request = new Request("http://localhost/v1/chat/send"),
  transaction = {
    query: {
      organizationSettings: {
        findFirst: async () => null,
      },
    },
  },
}: {
  contextMatterIds: SendMessageCtx["body"]["contextMatterIds"];
  request?: Request;
  transaction?: unknown;
}): SendMessageCtx => {
  const { safeDb, scopedDb } = createScopedDbMock(transaction);

  return asTestRaw<SendMessageCtx>({
    body: {
      threadId,
      sendMode: CHAT_SEND_MODE.rawOverride,
      contextMatterIds,
      message: {
        id: messageId,
        role: "user",
        parts: [{ type: "text", content: "Summarize the selected matters" }],
      },
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
    safeDb,
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
                contextMatterIds: [],
                dataWorkspaceIds: [],
                id: threadId,
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

  test("rolls back when the client disconnects during context compaction", async () => {
    const abortController = new AbortController();
    analyticsCreationHook = () => {
      analyticsCreationHook = undefined;
      abortController.abort();
    };
    const insertValues = mock(async () => undefined);
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
            chatMessages: { findFirst: async () => null },
            chatThreadCompactions: { findFirst: async () => null },
            chatThreads: { findFirst: async () => null },
            organizationSettings: { findFirst: async () => null },
          },
          select: selectChatMessages,
        },
      }),
    );
    analyticsCreationHook = undefined;

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(deleteReturning).toHaveBeenCalledTimes(1);
  });

  test("rolls back when the client disconnects during context preparation", async () => {
    const abortController = new AbortController();
    let organizationSettingsReads = 0;
    const findOrganizationSettings = mock(async () => {
      organizationSettingsReads += 1;
      if (organizationSettingsReads === 2) {
        abortController.abort();
      }
      return null;
    });
    const insertValues = mock(async () => undefined);
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
            chatMessages: { findFirst: async () => null },
            chatThreadCompactions: { findFirst: async () => null },
            chatThreads: { findFirst: async () => null },
            organizationSettings: { findFirst: findOrganizationSettings },
          },
          select: selectChatMessages,
        },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Client disconnected before AI work started" },
    });
    expect(findOrganizationSettings).toHaveBeenCalledTimes(2);
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(deleteReturning).toHaveBeenCalledTimes(1);
  });
});
