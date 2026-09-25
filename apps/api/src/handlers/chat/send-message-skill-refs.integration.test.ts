import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { agentSkills, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { AuditEvent } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const streamChatMock = mock(
  async () =>
    new Response("stream started", {
      headers: { "Content-Type": "text/event-stream" },
    }),
);
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

const RUN = Bun.randomUUIDv7().slice(-12);
const PICKED_SLUG = `picked-review-${RUN}`;
const PICKED_BODY = `Apply the picked review methodology ${RUN}.`;
const MISSING_SLUG = `never-installed-${RUN}`;

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
let pickedSkillId: SafeId<"agentSkill">;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);

  pickedSkillId = toSafeId<"agentSkill">(Bun.randomUUIDv7());
  await testDb.insert(agentSkills).values({
    id: pickedSkillId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    scope: "private",
    origin: "authored",
    slug: PICKED_SLUG,
    name: "Picked review",
    description: "Skill picked from the composer.",
    metadata: {},
    contentHash: "0".repeat(64),
    body: PICKED_BODY,
    enabled: true,
  });
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await testDb.delete(agentSkills).where(inArray(agentSkills.id, [pickedSkillId]));
  await releaseRlsFixture();
});

const seedThread = async (): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Skill reference test",
    userId: ids.userA1,
    workspaceId: null,
  });
  return threadId;
};

const createContext = ({
  auditEvents,
  message,
  threadId,
}: {
  auditEvents: AuditEvent[];
  message: ChatSendRequest["message"];
  threadId: SafeId<"chatThread">;
}): SendMessageCtx => {
  const forwardedProps = {
    contextMatterIds: [],
    message,
    runId: `run-${message.id}`,
    sendMode: CHAT_SEND_MODE.rawOverride,
    threadId,
  };
  return asTestRaw<SendMessageCtx>({
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
    createAuditRecorder:
      () =>
      async (_tx: unknown, event: AuditEvent | AuditEvent[]) => {
        auditEvents.push(...(Array.isArray(event) ? event : [event]));
      },
    getAccessibleWorkspaces: async () => [
      { id: ids.wsA1, status: "active" },
      { id: ids.wsA2, status: "active" },
    ],
    getActiveWorkspaceIds: async () => [ids.wsA1, ids.wsA2],
    getWorkspaceAccess: async () => null,
    memberRole: { role: "owner" },
    orgAIConfig,
    pinServerValidatedWorkspaceId: () => false,
    promptCachingEnabled: false,
    recordAuditEvent: async () => {},
    request: new Request("http://localhost/v1/chat/send"),
    route: "/v1/chat/send",
    safeDb,
    scopedDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
  });
};

describe("explicit skill references in a user message", () => {
  test("preload an available skill into the turn and name an unavailable one", async () => {
    const threadId = await seedThread();
    const auditEvents: AuditEvent[] = [];
    streamChatMock.mockClear();

    const result = await sendMessage.handler(
      createContext({
        auditEvents,
        message: {
          id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
          parts: [
            {
              content: `Use [Picked review](#stella-skill-ref=${PICKED_SLUG}) and [Gone](#stella-skill-ref=${MISSING_SLUG}) on this.`,
              type: "text",
            },
          ],
          role: "user",
        },
        threadId,
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    const systemUntrusted =
      asTestRaw<{ systemUntrusted?: string }[][]>(streamChatMock.mock.calls)
        .at(0)
        ?.at(0)?.systemUntrusted ?? "";
    expect(systemUntrusted).toContain(PICKED_BODY);
    expect(systemUntrusted).toContain(MISSING_SLUG);
    expect(
      auditEvents.filter((event) => event.resourceId === pickedSkillId),
    ).toEqual([
      expect.objectContaining({
        metadata: {
          outcome: "success",
          path: null,
          slug: PICKED_SLUG,
          surface: "chat",
        },
      }),
    ]);
  });
});
