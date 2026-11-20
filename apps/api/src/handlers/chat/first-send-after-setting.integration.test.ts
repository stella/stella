import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { agentSkills, chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import updateThread from "@/api/handlers/chat/threads/update";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import updateThreadModel from "@/api/handlers/chat/update-thread-model";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createChatStreamMock } from "@/api/tests/helpers/chat-stream-mock";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * A new chat can store its thread row before the first message: choosing a
 * model or turning web search on in the composer writes the setting at once.
 * The first send into that row must still start the chat it describes: the
 * skill it was opened from and the matters it draws from reach the row and
 * the prompt, exactly as when the send creates the thread.
 */

const RUN = Bun.randomUUIDv7().slice(-12);
const SKILL_SLUG = `first-send-skill-${RUN}`;
const OTHER_SKILL_SLUG = `first-send-other-${RUN}`;
const ACTIVE_SKILL_HEADING = "ACTIVE SKILL CONTEXT";
const ACTIVE_SKILL_NAME_LINE =
  "Canonical skill name for load-skill/read-skill-resource: ";

/** The skill the prompt's active-skill section names; null without one. */
const promptActiveSkill = (prompt: string): string | null => {
  if (!prompt.includes(ACTIVE_SKILL_HEADING)) {
    return null;
  }
  const line = prompt
    .split("\n")
    .find((candidate) => candidate.startsWith(ACTIVE_SKILL_NAME_LINE));
  return line?.slice(ACTIVE_SKILL_NAME_LINE.length).trim() ?? "";
};

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

const streamChatMock = createChatStreamMock();

const sendMessage = createSendMessage({
  compactMessagesForContext,
  createRefRegistry: createChatRefRegistry,
  indexThread: async () => undefined,
  loadExternalMcpTools: async () => {
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
  },
  loadWebSearchProviders: async () => ({
    urlFetcher: null,
    webSearchProvider: null,
  }),
  rollbackSideEffects: rollbackUnpersistedChatSideEffects,
  streamResponse: streamChatMock,
  uploadMessageFiles: uploadMessageFilesWithRollback,
});
type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
let skill: NonNullable<ChatSendRequest["activeSkill"]>;
let otherSkill: NonNullable<ChatSendRequest["activeSkill"]>;
const seededSkillIds: SafeId<"agentSkill">[] = [];
const threadIds: SafeId<"chatThread">[] = [];

const seedSkill = async (slug: string) => {
  const id = toSafeId<"agentSkill">(Bun.randomUUIDv7());
  seededSkillIds.push(id);
  await testDb.insert(agentSkills).values({
    id,
    organizationId: ids.orgA,
    userId: ids.userA1,
    scope: "private",
    origin: "authored",
    slug,
    name: `Skill ${slug}`,
    description: `The ${slug} skill.`,
    metadata: {},
    contentHash: "0".repeat(64),
    body: `Follow the ${slug} steps.`,
    enabled: true,
  });
  return { skillId: id, skillName: slug };
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
  skill = await seedSkill(SKILL_SLUG);
  otherSkill = await seedSkill(OTHER_SKILL_SLUG);
});

afterAll(async () => {
  if (threadIds.length > 0) {
    await testDb.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
  }
  await testDb
    .delete(agentSkills)
    .where(inArray(agentSkills.id, seededSkillIds));
  await releaseRlsFixture();
});

const newThreadId = () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  threadIds.push(threadId);
  return threadId;
};

const settingContext = () => ({
  audit: async () => undefined,
  getWorkspaceAccess: async () => null,
  orgAIConfig,
  query: {},
  safeDb,
  scopedDb,
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
});

type ModelCtx = Parameters<typeof updateThreadModel.handler>[0];
type WebSearchCtx = Parameters<typeof updateThread.handler>[0];

/** The composer settings a member can choose before the first message. */
const SETTINGS = [
  {
    name: "model",
    choose: async (threadId: SafeId<"chatThread">) =>
      await updateThreadModel.handler(
        createTestHandlerContext<ModelCtx>({
          ...settingContext(),
          body: { model: "openai::gpt-5.4", reasoningEffort: null },
          params: { threadId },
        }),
      ),
    stored: { chatModel: "openai::gpt-5.4" },
  },
  {
    name: "web search",
    choose: async (threadId: SafeId<"chatThread">) =>
      await updateThread.handler(
        createTestHandlerContext<WebSearchCtx>({
          ...settingContext(),
          body: { webSearchEnabled: true },
          params: { threadId },
        }),
      ),
    stored: { webSearchEnabled: true },
  },
];

/** A send from the composer: the skill and matters ride on every one. */
const send = async ({
  activeSkill,
  contextMatterIds,
  text,
  threadId,
}: {
  activeSkill: ChatSendRequest["activeSkill"];
  contextMatterIds: SafeId<"workspace">[];
  text: string;
  threadId: SafeId<"chatThread">;
}) => {
  const message: ChatSendRequest["message"] = {
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    parts: [{ content: text, type: "text" }],
    role: "user",
  };
  const forwardedProps = {
    ...(activeSkill === undefined ? {} : { activeSkill }),
    contextMatterIds,
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
      createAuditRecorder: () => async () => undefined,
      getAccessibleWorkspaces: async () => [
        { id: ids.wsA1, status: "active" },
        { id: ids.wsA2, status: "active" },
      ],
      getActiveWorkspaceIds: async () => [ids.wsA1, ids.wsA2],
      getWorkspaceAccess: async () => null,
      memberRole: sessionMemberRole("owner"),
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu" as const,
      pinServerValidatedWorkspaceId: () => false,
      promptCachingEnabled: false,
      recordAuditEvent: async () => undefined,
      request: new Request("http://localhost/v1/chat"),
      route: "/v1/chat" satisfies ApiRoutePath,
      headers: {},
      safeDb,
      scopedDb,
      set: { headers: {}, status: 200 },
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );
  expect(result).toBeInstanceOf(Response);
  const prompt =
    asTestRaw<{ systemUntrusted?: string }[][]>(streamChatMock.mock.calls)
      .at(0)
      ?.at(0)?.systemUntrusted ?? "";
  return { prompt };
};

const storedThread = async (threadId: SafeId<"chatThread">) =>
  await testDb.query.chatThreads.findFirst({
    where: { id: { eq: threadId } },
    columns: {
      activeSkill: true,
      chatModel: true,
      contextMatterIds: true,
      webSearchEnabled: true,
    },
  });

describe("a setting chosen before a new chat's first message", () => {
  test.each(SETTINGS)(
    "keeps the chat's skill and matters when the $name is chosen first",
    async ({ choose, stored }) => {
      const threadId = newThreadId();
      const chosen = await choose(threadId);
      expect(chosen).not.toHaveProperty("code");
      // The setting stored the row before any message, without the skill.
      expect(await storedThread(threadId)).toMatchObject({
        activeSkill: null,
        contextMatterIds: [],
      });

      const { prompt } = await send({
        activeSkill: skill,
        contextMatterIds: [ids.wsA2],
        text: "Is this a good skill?",
        threadId,
      });

      expect(promptActiveSkill(prompt)).toBe(SKILL_SLUG);
      expect(prompt).toContain(
        "MATTER SCOPE: This chat is pinned to one matter.",
      );
      expect(await storedThread(threadId)).toMatchObject({
        activeSkill: skill,
        contextMatterIds: [ids.wsA2],
        // The setting chosen first stays.
        ...stored,
      });
    },
  );

  test("a chat that already holds a message keeps the skill it started with", async () => {
    const threadId = newThreadId();
    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: "Skill review",
      workspaceId: null,
      activeSkill: skill,
      contextMatterIds: [],
      dataWorkspaceIds: [],
    });
    const base = Date.parse("2026-01-05T09:00:00Z");
    await testDb.insert(chatMessages).values([
      {
        content: toPersistedChatMessageContentV3({
          data: [{ type: "text", content: "Is this a good skill?" }],
        }),
        createdAt: new Date(base - 2000),
        id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        role: "user",
        threadId,
        userId: ids.userA1,
        workspaceId: null,
      },
      {
        content: toPersistedChatMessageContentV3({
          data: [{ type: "text", content: "It reads well." }],
        }),
        createdAt: new Date(base - 1000),
        id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        role: "assistant",
        threadId,
        userId: ids.userA1,
        workspaceId: null,
      },
    ]);
    expect(otherSkill.skillName).not.toBe(skill.skillName);

    const { prompt } = await send({
      activeSkill: otherSkill,
      contextMatterIds: [],
      text: "And this one?",
      threadId,
    });

    expect(promptActiveSkill(prompt)).toBe(SKILL_SLUG);
    expect(await storedThread(threadId)).toMatchObject({ activeSkill: skill });
  });
});
