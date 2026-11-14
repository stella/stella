import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  chatThreads,
  chatToolGrants,
  organizationSettings,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { chatSafePromptText } from "@/api/handlers/chat/chat-prompt";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import { getChatToolPolicy } from "@/api/handlers/chat/tools/tool-policy";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createChatStreamMock } from "@/api/tests/helpers/chat-stream-mock";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const streamChatMock = createChatStreamMock();
const loadExternalMcpToolsForTest = async () => {
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
};

const sendMessage = createSendMessage({
  compactMessagesForContext,
  createRefRegistry: createChatRefRegistry,
  indexThread: async () => undefined,
  loadExternalMcpTools: loadExternalMcpToolsForTest,
  loadWebSearchProviders: async () => ({
    urlFetcher: null,
    webSearchProvider: null,
  }),
  rollbackSideEffects: rollbackUnpersistedChatSideEffects,
  streamResponse: streamChatMock,
  uploadMessageFiles: uploadMessageFilesWithRollback,
});
type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];

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

let testDb: TestDatabase;
let ids: TestIds;
const seededThreadIds: SafeId<"chatThread">[] = [];
const instructions = [
  "Řehák: citujte české předpisy.",
  "Žiak: citujte slovenské predpisy.",
] as const;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  for (const [organizationId, aiInstructions] of [
    [ids.orgA, instructions[0]],
    [ids.orgB, instructions[1]],
  ] as const) {
    await testDb
      .insert(organizationSettings)
      .values({
        id: createSafeId<"organizationSettings">(),
        organizationId,
        aiInstructions,
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: { aiInstructions },
      });
  }
});
afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

test("chat inherits only its organization's instructions and retains granted tool authorization", async () => {
  for (const tenant of [
    {
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsA1, ids.wsA2],
      own: instructions[0],
      other: instructions[1],
    },
    {
      organizationId: ids.orgB,
      userId: ids.userB1,
      workspaceIds: [ids.wsB1],
      own: instructions[1],
      other: instructions[0],
    },
  ]) {
    const scopedDb = asTestRaw<ScopedDb>(
      createScopedDb(
        testDb,
        tenant.workspaceIds,
        tenant.organizationId,
        tenant.userId,
      ),
    );
    const safeDb = toSafeDbMock(scopedDb);
    const visible = await safeDb((tx) =>
      tx.query.organizationSettings.findMany({
        columns: { organizationId: true, aiInstructions: true },
        limit: 10,
      }),
    );
    expect(visible).toMatchObject({
      value: [
        { organizationId: tenant.organizationId, aiInstructions: tenant.own },
      ],
    });
    const threadId = createSafeId<"chatThread">();
    seededThreadIds.push(threadId);
    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      title: "Právní pokyny",
      workspaceId: null,
    });
    await testDb.insert(chatToolGrants).values({
      id: createSafeId<"chatToolGrant">(),
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      chatThreadId: threadId,
      scope: "conversation",
      toolName: "search-all-past-chats",
    });
    const message = {
      id: createSafeId<"chatMessage">(),
      role: "user",
      parts: [{ type: "text", content: "Prosím o stručnou odpověď." }],
    } as const;
    const forwardedProps = {
      contextMatterIds: tenant.workspaceIds,
      userContext: {
        userName: "JUDr. Řehák",
        locale: "cs",
        timezone: "Europe/Prague",
      },
      message,
      runId: `run-${message.id}`,
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId,
    };
    streamChatMock.mockClear();
    const result = await sendMessage.handler(
      asTestRaw<SendMessageCtx>({
        body: {
          threadId,
          runId: forwardedProps.runId,
          state: {},
          messages: [message],
          tools: [],
          context: [],
          forwardedProps,
          data: forwardedProps,
        },
        createAuditRecorder: () => async () => {},
        getAccessibleWorkspaces: async () =>
          tenant.workspaceIds.map((id) => ({ id, status: "active" })),
        getActiveWorkspaceIds: async () => tenant.workspaceIds,
        getWorkspaceAccess: async () => null,
        memberRole: sessionMemberRole("owner"),
        orgAIConfig,
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
        managedAIResidency: "eu",
        pinServerValidatedWorkspaceId: () => false,
        promptCachingEnabled: false,
        recordAuditEvent: async () => {},
        request: new Request("http://localhost/v1/chat"),
        route: "/v1/chat" satisfies ApiRoutePath,
        safeDb,
        scopedDb,
        session: { activeOrganizationId: tenant.organizationId },
        user: { id: tenant.userId },
      }),
    );
    expect(result).toBeInstanceOf(Response);
    const request = streamChatMock.mock.calls.at(0)?.at(0);
    expect(request).toBeDefined();
    if (!request) {
      panic("Chat did not reach streaming");
    }
    const prompt = `${chatSafePromptText(request.systemSafe)}${request.systemUntrusted}`;
    expect(prompt).toContain(tenant.own);
    expect(prompt).not.toContain(tenant.other);
    expect(prompt.indexOf(tenant.own)).toBeLessThan(
      prompt.indexOf("User registered as:"),
    );
    const tool = request.tools["search-all-past-chats"];
    expect(tool).toBeDefined();
    if (!tool) {
      panic("Chat did not register the granted tool");
    }
    expect(getChatToolPolicy(tool).needsApproval).toBe(true);
    expect(tool.needsApproval).toBeUndefined();
    expect(request.tools["update_organization_settings"]?.needsApproval).toBe(
      true,
    );
    await testDb
      .delete(chatToolGrants)
      .where(eq(chatToolGrants.chatThreadId, threadId));
  }
});
