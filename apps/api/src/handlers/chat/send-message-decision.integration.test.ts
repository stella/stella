import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import { createGetThreads } from "@/api/handlers/chat/threads/list";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionBadges } from "@/api/lib/case-law/decision-badges";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createChatStreamMock } from "@/api/tests/helpers/chat-stream-mock";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withPublicLawReaderRole } from "@/api/tests/pglite-test-db";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;

const threadId = createSafeId<"chatThread">();
const decisionId = createSafeId<"caseLawDecision">();
const sourceId = createSafeId<"caseLawSource">();

const asyncCaseLawDb = asTestRaw<CaseLawPublicReadDb>(
  async <T>(read: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
    await withPublicLawReaderRole(
      testDb,
      async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
    ),
);

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
  caseLawDb: asyncCaseLawDb,
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

const getThreads = createGetThreads({
  readDecisionBadges: async ({ decisionIds }) =>
    await readPublicDecisionBadges({
      caseLawDb: asyncCaseLawDb,
      decisionIds,
      readCourtWeights: async () => new Map(),
    }),
});

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
  await testDb
    .insert(caseLawSources)
    .values(caseLawSourceRow({ id: sourceId }));
  await testDb.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId,
    caseNumber: "25 Cdo 1234/2021",
    country: "CZE",
    court: "Nejvyšší soud",
    decisionDate: "2021-03-12",
    language: "cs",
    slug: "history-decision-test",
  });
});

afterAll(async () => {
  await testDb.delete(chatThreads).where(eq(chatThreads.id, threadId));
  await testDb
    .delete(caseLawDecisions)
    .where(eq(caseLawDecisions.id, decisionId));
  await testDb.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
  await releaseRlsFixture();
});

const createContext = (): SendMessageCtx => {
  const message = {
    id: createSafeId<"chatMessage">(),
    role: "user",
    parts: [{ type: "text", content: "Explain the decision in the reader." }],
  } as const;
  const forwardedProps = {
    activeDecision: { decisionId },
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
    createAuditRecorder: () => async () => {},
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
    recordAuditEvent: async () => {},
    request: new Request("http://localhost/v1/chat/send"),
    route: "/v1/chat/send",
    safeDb,
    scopedDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
  });
};

test("the first send binds the reader decision to the listed thread badge", async () => {
  expect(
    await testDb.query.chatThreads.findFirst({
      where: { id: { eq: threadId } },
    }),
  ).toBeUndefined();

  const response = await sendMessage.handler(createContext());
  expect(response).toBeInstanceOf(Response);
  expect(streamChatMock).toHaveBeenCalledTimes(1);

  const listed = await getThreads.handler(
    asTestRaw<Parameters<typeof getThreads.handler>[0]>({
      memberRole: sessionMemberRole("owner"),
      query: { limit: 100 },
      request: new Request("http://localhost/v1/chat/threads"),
      safeDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );
  if ("code" in listed) {
    throw new TypeError(`get-threads failed: ${JSON.stringify(listed)}`);
  }
  expect(
    listed.global.find((thread) => thread.id === threadId)?.decision,
  ).toEqual({
    type: "present",
    badge: {
      id: decisionId,
      caseNumber: "25 Cdo 1234/2021",
      country: "CZE",
      court: "Nejvyšší soud",
      courtAbbreviation: "NS",
      courtTier: "other",
      decisionDate: "2021-03-12",
      language: "cs",
      languageAlternates: [],
      slug: "history-decision-test",
    },
  });
});
