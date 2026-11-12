import { Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_THREAD_PLACEHOLDER_TITLE } from "@stll/api-contract";
import type { ChatLocalRunTarget } from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_FEATURE_ID,
  type DesktopRunnerHarnessReport,
} from "@stll/api-contract/desktop-runner";
import { createTestState } from "@stll/test-state";

import { user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads, featureEnrolments } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { chatRunTargetOf } from "@/api/lib/chat/run-target";
import type {
  DesktopRunnerControl,
  PickedDesktop,
} from "@/api/lib/desktop-runner/control";
import { createLocalRunBell } from "@/api/lib/desktop-runner/doorbell";
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

/**
 * A new chat whose member chose Codex on their computer: its first send
 * creates the thread on that target and hands the turn to the computer the
 * gateway picks, and a reload reads the same target back.
 */

const CODEX: ChatLocalRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
  reasoningEffort: null,
};

const CODEX_READY: DesktopRunnerHarnessReport & { id: "codex" } = {
  id: "codex",
  state: "ready",
  version: "0.50.0",
  capabilities: ["approvals"],
  approvalModes: ["ask"],
  models: [{ id: CODEX.model, label: "GPT-5 Codex", reasoningEfforts: [] }],
};

const DESKTOP_ID = Bun.randomUUIDv7();

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

const testState = createTestState({ file: import.meta.path, config: env });
const streamChatMock = createChatStreamMock();
const picks: { harness: string; userId: string }[] = [];
const control = asTestRaw<DesktopRunnerControl>({
  pickDesktop: async ({
    owner,
    harness,
  }: Parameters<DesktopRunnerControl["pickDesktop"]>[0]) => {
    picks.push({ harness, userId: owner.userId });
    const picked: PickedDesktop = {
      type: "available",
      desktopId: DESKTOP_ID,
      harness: CODEX_READY,
    };
    return await Promise.resolve(Result.ok(picked));
  },
});

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
  localRunRuntime: { control, runBell: createLocalRunBell() },
  rollbackSideEffects: rollbackUnpersistedChatSideEffects,
  streamResponse: streamChatMock,
  uploadMessageFiles: uploadMessageFilesWithRollback,
});
type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const threadIds: SafeId<"chatThread">[] = [];
let emailVerifiedBefore = false;

testState.beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
  // A feature is offered only to a verified member, who turned this one on.
  const [member] = await testDb
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, ids.userA1));
  emailVerifiedBefore = member?.emailVerified ?? false;
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  await testDb
    .insert(featureEnrolments)
    .values({
      featureId: DESKTOP_RUNNER_FEATURE_ID,
      organizationId: ids.orgA,
      userId: ids.userA1,
    })
    .onConflictDoNothing();
  // The organization may run chat turns on computers.
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    [DESKTOP_RUNNER_FEATURE_ID]: [
      { type: "organization", organizationId: ids.orgA },
    ],
  });
});

afterAll(async () => {
  if (threadIds.length > 0) {
    await testDb.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
  }
  await testDb
    .delete(featureEnrolments)
    .where(
      and(
        eq(featureEnrolments.featureId, DESKTOP_RUNNER_FEATURE_ID),
        eq(featureEnrolments.organizationId, ids.orgA),
        eq(featureEnrolments.userId, ids.userA1),
      ),
    );
  await testDb
    .update(user)
    .set({ emailVerified: emailVerifiedBefore })
    .where(eq(user.id, ids.userA1));
  await releaseRlsFixture();
});

const newThreadId = () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  threadIds.push(threadId);
  return threadId;
};

/** The first send of a new chat, as the composer posts it. */
const firstSend = (
  threadId: SafeId<"chatThread">,
  runTarget: ChatSendRequest["runTarget"],
): SendMessageCtx => {
  const message: ChatSendRequest["message"] = {
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    parts: [{ content: "Run the tests", type: "text" }],
    role: "user",
  };
  const forwardedProps = {
    contextMatterIds: [],
    message,
    runId: `run-${message.id}`,
    ...(runTarget === undefined ? {} : { runTarget }),
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
    safeDb,
    scopedDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
  });
};

/** What a reload of the thread reads as its run target. */
const storedRunTarget = async (threadId: SafeId<"chatThread">) => {
  const row = await testDb.query.chatThreads.findFirst({
    where: { id: { eq: threadId } },
    columns: { chatLocalRunTarget: true },
  });
  return row === undefined
    ? undefined
    : chatRunTargetOf(row.chatLocalRunTarget);
};

/** The computer run the send handed its turn to, if any. */
const handedOff = () =>
  asTestRaw<{ localRun?: { harness: string } }[][]>(streamChatMock.mock.calls)
    .at(-1)
    ?.at(0)?.localRun;

describe("a new chat's first send bound for the member's computer", () => {
  test("creates the thread on that target and hands the turn to the computer", async () => {
    const threadId = newThreadId();
    picks.length = 0;
    streamChatMock.mockClear();

    const result = await sendMessage.handler(firstSend(threadId, CODEX));

    expect(result).toBeInstanceOf(Response);
    expect(picks).toEqual([{ harness: "codex", userId: ids.userA1 }]);
    expect(handedOff()?.harness).toBe("codex");
    expect(await storedRunTarget(threadId)).toEqual(CODEX);
  });

  test("runs where the draft's Run on choice stored it, and the thread keeps it", async () => {
    const threadId = newThreadId();
    // The model menu's PATCH stores the choice on the draft's placeholder row
    // before the chat has a message (`update-thread-model.ts`).
    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: CHAT_THREAD_PLACEHOLDER_TITLE,
      workspaceId: null,
      contextMatterIds: [],
      dataWorkspaceIds: [],
      chatLocalRunTarget: CODEX,
    });
    picks.length = 0;
    streamChatMock.mockClear();

    const result = await sendMessage.handler(firstSend(threadId, CODEX));

    expect(result).toBeInstanceOf(Response);
    expect(picks).toEqual([{ harness: "codex", userId: ids.userA1 }]);
    expect(handedOff()?.harness).toBe("codex");
    expect(await storedRunTarget(threadId)).toEqual(CODEX);
  });

  test("a first send without a target runs on stella and stores none", async () => {
    const threadId = newThreadId();
    picks.length = 0;
    streamChatMock.mockClear();

    const result = await sendMessage.handler(firstSend(threadId, undefined));

    expect(result).toBeInstanceOf(Response);
    expect(picks).toEqual([]);
    expect(handedOff()).toBeUndefined();
    expect(await storedRunTarget(threadId)).toEqual({ kind: "cloud" });
  });
});
