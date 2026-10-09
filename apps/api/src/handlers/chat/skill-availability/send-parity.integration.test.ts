import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  CHAT_EDIT_APPLY_MODE,
  CHAT_SKILL_DOCUMENT,
  type ChatEditApplyMode,
} from "@stll/api-contract";
import {
  listSkillMetadata,
  SKILL_REQUIRED_TOOLS_METADATA_KEY,
} from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { agentSkills, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import { createListUnavailableChatSkills } from "@/api/handlers/chat/skill-availability/list";
import { COUNTERPARTY_CHECK_TOOL_NAME } from "@/api/handlers/chat/tools/counterparty-check-tools";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import { GET_DOCUMENT_OUTLINE_TOOL_NAME } from "@/api/handlers/chat/tools/folio-agent-tools";
import { SEARCH_ALL_PAST_CHATS_TOOL_NAME } from "@/api/handlers/chat/tools/past-chat-tools";
import { WEB_SEARCH_TOOL_NAME } from "@/api/handlers/chat/tools/web-search-tools";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import { createChatStreamMock } from "@/api/tests/helpers/chat-stream-mock";
import {
  NO_AUDIT,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * What the composer menus offer in a chat and what a send in that chat
 * accepts are one decision. For each chat below, the availability endpoint
 * asked about that chat and a real send from it must agree on every skill:
 * the menu offers a skill exactly when the send runs it instead of naming it
 * unavailable.
 */

const RUN = Bun.randomUUIDv7().slice(-12);

const SKILLS = {
  browser: "use-browser",
  counterparty: COUNTERPARTY_CHECK_TOOL_NAME,
  matter: "create_matter_document",
  outline: `${GET_DOCUMENT_OUTLINE_TOOL_NAME} suggest_changes`,
  pastChats: SEARCH_ALL_PAST_CHATS_TOOL_NAME,
  redline: "suggest_changes",
  web: WEB_SEARCH_TOOL_NAME,
} as const;
type SkillKey = keyof typeof SKILLS;
const SKILL_KEYS = Object.keys(SKILLS).map((key) => asTestRaw<SkillKey>(key));
const slugOf = (key: SkillKey) => `parity-${key}-${RUN}`;
// The shipped skills, decided under their slug: the id the skill list gives
// a built-in, and the name a send references it by.
const BUILT_IN_SLUGS = listSkillMetadata().map(({ name }) => name);

const loadWebSearchProviders = async () =>
  await Promise.resolve({
    urlFetcher: null,
    webSearchProvider: {
      name: "tavily" as const,
      search: async () => await Promise.resolve({ results: [] }),
    },
  });

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
  loadWebSearchProviders,
  rollbackSideEffects: rollbackUnpersistedChatSideEffects,
  streamResponse: streamChatMock,
  uploadMessageFiles: uploadMessageFilesWithRollback,
});
type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];

const listUnavailableChatSkills = createListUnavailableChatSkills({
  loadWebSearchProviders,
});

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
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededSkillIds: SafeId<"agentSkill">[] = [];
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
  for (const key of SKILL_KEYS) {
    const id = toSafeId<"agentSkill">(Bun.randomUUIDv7());
    seededSkillIds.push(id);
    await testDb.insert(agentSkills).values({
      id,
      organizationId: ids.orgA,
      userId: ids.userA1,
      scope: "private",
      origin: "authored",
      slug: slugOf(key),
      name: `Parity ${key}`,
      description: `Parity skill ${key}.`,
      metadata: { [SKILL_REQUIRED_TOOLS_METADATA_KEY]: SKILLS[key] },
      contentHash: "0".repeat(64),
      body: `Run the ${key} parity step ${RUN}.`,
      enabled: true,
    });
  }
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await testDb
    .delete(agentSkills)
    .where(inArray(agentSkills.id, seededSkillIds));
  await releaseRlsFixture();
});

type Chat = {
  anonymized: boolean;
  browserExtension: boolean;
  /** Omitted: the composer sends none and the send's default applies. */
  editApplyMode?: ChatEditApplyMode;
  /** An open file, and whether its file field is known. */
  file: false | { withField: boolean };
  matter: boolean;
  /** The chat draws from a pinned matter. */
  pinned?: boolean;
  webSearch: boolean;
};

// Only its shape matters: no tool built here runs.

const workspaces = (): AccessibleWorkspace[] => [
  { id: ids.wsA1, status: "active" },
  { id: ids.wsA2, status: "active" },
];

const callerContext = () => ({
  getAccessibleWorkspaces: async () => workspaces(),
  getActiveWorkspaceIds: async () => [ids.wsA1, ids.wsA2],
  getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) =>
    workspaces().find(({ id }) => id === workspaceId) ?? null,
  memberRole: sessionMemberRole("owner"),
  orgAIConfig,
  safeDb,
  scopedDb,
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
});

/** The skills the menu offers in `chat`: seeded keys and built-in slugs. */
const menuOffers = async (chat: Chat): Promise<ReadonlySet<string>> => {
  const result = await listUnavailableChatSkills.handler(
    createTestHandlerContext<
      Parameters<typeof listUnavailableChatSkills.handler>[0]
    >({
      audit: NO_AUDIT,
      ...callerContext(),
      query: {
        anonymized: chat.anonymized,
        browserExtension: chat.browserExtension,
        webSearch: chat.webSearch,
        ...(chat.editApplyMode === undefined
          ? {}
          : { editApplyMode: chat.editApplyMode }),
        ...(chat.file === false
          ? {}
          : {
              document: CHAT_SKILL_DOCUMENT.file,
              documentId: ids.entityA1,
              ...(chat.file.withField ? { fileFieldId: ids.fieldA1 } : {}),
            }),
        ...(chat.matter ? { workspaceId: ids.wsA1 } : {}),
        ...(chat.pinned === true ? { contextMatterIds: [ids.wsA2] } : {}),
      },
    }),
  );
  if ("code" in result) {
    throw new TypeError(`expected the availability list, got ${result.code}`);
  }
  const withheld = new Set<string>(
    [...result.unavailable, ...result.unavailableHere].map(
      ({ skillId }) => skillId,
    ),
  );
  return new Set([
    ...SKILL_KEYS.filter((_, index) => {
      const skillId = seededSkillIds.at(index);
      return skillId !== undefined && !withheld.has(skillId);
    }),
    ...BUILT_IN_SLUGS.filter((slug) => !withheld.has(slug)),
  ]);
};

/** The skills a send from `chat` runs rather than names unavailable. */
const sendAccepts = async (chat: Chat): Promise<ReadonlySet<string>> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const workspaceId = chat.matter ? ids.wsA1 : null;
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Skill availability parity",
    userId: ids.userA1,
    webSearchEnabled: chat.webSearch,
    workspaceId,
  });
  const message: ChatSendRequest["message"] = {
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    parts: [
      {
        content: `Use ${[
          ...SKILL_KEYS.map(
            (key) => `[Parity ${key}](#stella-skill-ref=${slugOf(key)})`,
          ),
          ...BUILT_IN_SLUGS.map(
            (slug) => `[${slug}](#stella-skill-ref=${slug})`,
          ),
        ].join(" and ")}.`,
        type: "text",
      },
    ],
    role: "user",
  };
  const forwardedProps = {
    ...(chat.browserExtension
      ? { browserClient: { protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION } }
      : {}),
    ...(chat.editApplyMode === undefined
      ? {}
      : { editApplyMode: chat.editApplyMode }),
    ...(chat.file === false
      ? {}
      : {
          activeFile: {
            entityId: ids.entityA1,
            fileName: "entityA1.docx",
            supportsDocxEdits: true,
            ...(chat.file.withField ? { fileFieldId: ids.fieldA1 } : {}),
          },
        }),
    ...(workspaceId === null ? {} : { workspaceId }),
    contextMatterIds: chat.pinned === true ? [ids.wsA2] : [],
    message,
    runId: `run-${message.id}`,
    sendMode: chat.anonymized
      ? CHAT_SEND_MODE.anonymized
      : CHAT_SEND_MODE.rawOverride,
    threadId,
  };
  streamChatMock.mockClear();
  const result = await sendMessage.handler(
    asTestRaw<SendMessageCtx>({
      ...callerContext(),
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
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu" as const,
      pinServerValidatedWorkspaceId: () => false,
      promptCachingEnabled: false,
      recordAuditEvent: async () => undefined,
      request: new Request("http://localhost/v1/chat/send"),
      route: "/v1/chat/send",
    }),
  );
  expect(result).toBeInstanceOf(Response);
  const systemUntrusted =
    asTestRaw<{ systemUntrusted?: string }[][]>(streamChatMock.mock.calls)
      .at(0)
      ?.at(0)?.systemUntrusted ?? "";
  const unavailableLine =
    systemUntrusted
      .split("\n")
      .find((line) => line.includes("UNAVAILABLE SKILLS")) ?? "";
  return new Set([
    ...SKILL_KEYS.filter((key) => !unavailableLine.includes(slugOf(key))),
    ...BUILT_IN_SLUGS.filter((slug) => !unavailableLine.includes(slug)),
  ]);
};

const CHATS: readonly (Chat & { name: string })[] = [
  {
    name: "the widest chat: a matter chat over a file, edits queued for review",
    anonymized: false,
    browserExtension: true,
    editApplyMode: CHAT_EDIT_APPLY_MODE.manual,
    file: { withField: false },
    matter: true,
    webSearch: true,
  },
  {
    name: "a matter chat over a file whose edits apply directly",
    anonymized: false,
    browserExtension: true,
    editApplyMode: CHAT_EDIT_APPLY_MODE.auto,
    file: { withField: true },
    matter: true,
    webSearch: true,
  },
  {
    name: "an anonymized global chat with nothing on",
    anonymized: true,
    browserExtension: false,
    file: false,
    matter: false,
    webSearch: false,
  },
  {
    name: "a global chat drawing from a pinned matter",
    anonymized: false,
    browserExtension: false,
    file: false,
    matter: false,
    pinned: true,
    webSearch: false,
  },
  {
    name: "a matter chat without the extension or a document",
    anonymized: false,
    browserExtension: false,
    file: false,
    matter: true,
    webSearch: true,
  },
  {
    name: "an anonymized global chat over a file, in the default edit mode",
    anonymized: true,
    browserExtension: true,
    file: { withField: false },
    matter: false,
    webSearch: false,
  },
];

describe("the composer menu and the send path decide skill availability alike", () => {
  for (const chat of CHATS) {
    test(chat.name, async () => {
      const offered = await menuOffers(chat);
      const accepted = await sendAccepts(chat);
      expect(
        violationsOf(
          CHAT_ORACLE.skillsMenuMatchesSend,
          [...SKILL_KEYS, ...BUILT_IN_SLUGS].flatMap((skill) =>
            offered.has(skill) === accepted.has(skill)
              ? []
              : [
                  {
                    menuOffers: offered.has(skill),
                    sendRuns: accepted.has(skill),
                    skill,
                  },
                ],
          ),
        ),
      ).toEqual([]);
    });
  }

  test("every skill is offered in one of these chats and withheld in another", async () => {
    const offered = await Promise.all(CHATS.map(menuOffers));
    for (const key of SKILL_KEYS) {
      expect(offered.some((chat) => chat.has(key))).toBe(true);
      expect(offered.some((chat) => !chat.has(key))).toBe(true);
    }
  });
});
