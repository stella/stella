import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  RESOURCE_TYPE,
  resourceRef,
  toChatResourceHref,
} from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreadNames, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  settleChatTurnOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type ChatRefRegistry,
  createChatRefRegistry,
} from "@/api/lib/chat/ref-registry";
import {
  CHAT_REF_ENCODING,
  type ChatRefBinding,
  type ChatRefContext,
} from "@/api/lib/chat/ref-token";
import { CHAT_THREAD_NAME_KIND } from "@/api/lib/chat/thread-name-kinds";
import { recordChatThreadNamesOnTx } from "@/api/lib/chat/thread-names";
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

/** The ref registry each request built, newest last. */
const builtRegistries: ChatRefRegistry[] = [];

/**
 * Runs while a request prepares, before it accepts its turn: where another
 * request of the thread can settle and store names.
 */
let beforeAcceptance: ((tx: Transaction) => Promise<void>) | undefined;

const sendMessage = createSendMessage({
  compactMessagesForContext,
  createRefRegistry: (bindings, retired) => {
    const registry = createChatRefRegistry(bindings, retired);
    builtRegistries.push(registry);
    return registry;
  },
  indexThread: async () => undefined,
  loadExternalMcpTools: loadExternalMcpToolsForTest,
  loadWebSearchProviders: async (tx) => {
    // In the request's own transaction: the test database has one
    // connection.
    await beforeAcceptance?.(asTestRaw<Transaction>(tx));
    return { urlFetcher: null, webSearchProvider: null };
  },
  rollbackSideEffects: rollbackUnpersistedChatSideEffects,
  streamResponse: asTestRaw(streamChatMock),
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

const ASK_USER_CALL_ID = "ask-1";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const unwrap = <T>(result: Result<T, unknown>): T => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

const askUserInput = {
  analysis: "Two DPAs found",
  questions: [
    { question: "Which DPA?", reason: "Only one should calibrate the review." },
  ],
};

const pendingAskUserCall = {
  arguments: JSON.stringify(askUserInput),
  id: ASK_USER_CALL_ID,
  input: askUserInput,
  name: "ask-user",
  state: "input-complete",
  type: "tool-call",
} satisfies ChatPart;

// A code-mode result keeps the refs its script returned: nothing resolves
// them back to ids, so only the stored binding says what `ent_1` meant.
const listedPart = {
  content: "Listed: ent_1 (CloudStore DPA).",
  type: "text",
} satisfies ChatPart;

/** Where a seeded thread records what `ent_1` names. */
const BINDING_STORE = {
  /** On the thread, beside a message that carries no binding: entity A. */
  thread: "thread",
  /** Only on the message, as a thread whose state is not stored yet:
   *  entity A. */
  message: "message",
  /** Nowhere: the message was stored before bindings existed, so what
   *  `ent_1` named is unknown. */
  legacy: "legacy",
  /** Both: a message stored before bindings existed showed `ent_1`, and a
   *  later message bound the spelling to entity A. What the model read
   *  first is unknown, so the spelling names nothing. */
  mixed: "mixed",
  /** On the thread, stored by another request that settles while this one
   *  prepares, after it began but before it accepts its turn: entity A. */
  late: "late",
} as const;

/** Whether `ent_1` still names entity A for the next request. */
const KEEPS_ENT_1 = {
  late: true,
  legacy: false,
  message: true,
  mixed: false,
  thread: true,
} as const satisfies Record<BindingStore, boolean>;

type BindingStore = (typeof BINDING_STORE)[keyof typeof BINDING_STORE];

/**
 * A turn that showed the model `ent_1` for entity A and now awaits an
 * `ask-user` answer. The user message before it mentions entity B.
 */
const seedAwaitingTurn = async (bindingStore: BindingStore) => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const binding = {
    kind: "entity",
    ref: "ent_1",
    entity: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: ids.entityA1 }),
    workspace: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: ids.wsA1 }),
  } satisfies ChatRefBinding;
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Ref continuation test",
    userId: ids.userA1,
    workspaceId: null,
  });
  const bindingRow = {
    kind: CHAT_THREAD_NAME_KIND.refBinding,
    name: binding.ref,
    target: binding,
    threadId,
  } as const;
  if (
    bindingStore === BINDING_STORE.thread ||
    bindingStore === BINDING_STORE.late
  ) {
    await testDb.insert(chatThreadNames).values({
      kind: CHAT_THREAD_NAME_KIND.ledgerStart,
      name: "",
      target: null,
      threadId,
    });
  }
  if (bindingStore === BINDING_STORE.thread) {
    await testDb.insert(chatThreadNames).values(bindingRow);
  }
  beforeAcceptance =
    bindingStore === BINDING_STORE.late
      ? async (tx) => {
          beforeAcceptance = undefined;
          await tx.insert(chatThreadNames).values(bindingRow);
        }
      : undefined;

  const mentionHref = toChatResourceHref({
    type: RESOURCE_TYPE.ENTITY,
    resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: ids.entityA2 }),
    location: {
      type: "workspace",
      workspace: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: ids.wsA1 }),
    },
  });
  const refContext = {
    version: 2,
    refs:
      bindingStore === BINDING_STORE.message ||
      bindingStore === BINDING_STORE.mixed
        ? [binding]
        : [],
    entities: [],
    unresolvedInputs: [],
    workspaceScope: [
      resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: ids.wsA1 }),
    ],
  } satisfies ChatRefContext;

  const acceptance = createChatTurnAcceptance({
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId,
    workspaceId: null,
  });
  unwrap(
    await safeDb(async (tx) => {
      if (bindingStore === BINDING_STORE.mixed) {
        await tx.insert(chatMessages).values({
          content: toChatMessageContent({
            data: [listedPart],
            metadata: {
              refContext: {
                entities: [],
                unresolvedInputs: [],
                version: 1,
                workspaceScope: refContext.workspaceScope,
              },
              refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
            },
            version: 2,
          }),
          // Stored before the turn below.
          createdAt: new Date(Date.now() - 60_000),
          id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
          role: "assistant",
          threadId,
          userId: ids.userA1,
          workspaceId: null,
        });
      }
      await tx.insert(chatMessages).values([
        {
          content: toChatMessageContent({
            data: [
              { content: `Compare with [B](${mentionHref})`, type: "text" },
            ],
            version: 2,
          }),
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: null,
        },
        {
          content: toChatMessageContent({
            data: [listedPart, pendingAskUserCall],
            metadata: {
              refContext:
                bindingStore === BINDING_STORE.legacy
                  ? ({
                      entities: refContext.entities,
                      unresolvedInputs: refContext.unresolvedInputs,
                      version: 1,
                      workspaceScope: refContext.workspaceScope,
                    } satisfies ChatRefContext)
                  : refContext,
              refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
            },
            version: 2,
          }),
          id: assistantMessageId,
          role: "assistant",
          threadId,
          userId: ids.userA1,
          workspaceId: null,
        },
      ]);
      expect(
        await insertChatTurnAcceptanceOnTx({ acceptance, tx }),
      ).toMatchObject({
        type: "accepted",
      });
    }),
  );
  const execution = unwrap(
    await claimChatTurnForExecution({
      acceptedTurnId: acceptance.id,
      incomingMessageId: userMessageId,
      incomingMessageRole: "user",
      organizationId: ids.orgA,
      safeDb,
      threadId,
      userId: ids.userA1,
      workspaceId: null,
    }),
  );
  if (execution === null) {
    throw new Error("Expected the accepted turn to be claimed");
  }
  unwrap(
    await safeDb(
      async (tx) =>
        await settleChatTurnOnTx({
          assistantMessageId,
          execution,
          outcome: {
            interaction: { toolCallId: ASK_USER_CALL_ID, type: "ask-user" },
            type: "awaiting-user",
          },
          tx,
        }),
    ),
  );
  return { assistantMessageId, threadId };
};

const createContext = ({
  message,
  threadId,
}: {
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

const messageText = (message: ChatMessage | undefined) =>
  (message?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("\n");

describe("chat refs across an interactive answer", () => {
  test.each(Object.values(BINDING_STORE))(
    "a new request keeps a stored ref's target and mints past it (binding on the %s)",
    async (bindingStore) => {
      const { assistantMessageId, threadId } =
        await seedAwaitingTurn(bindingStore);
      streamChatMock.mockClear();

      const result = await sendMessage.handler(
        createContext({
          message: {
            id: assistantMessageId,
            parts: [
              listedPart,
              {
                ...pendingAskUserCall,
                output: {
                  answers: [{ answer: "CloudStore", question: "Which DPA?" }],
                },
                state: "complete",
              },
            ],
            role: "assistant",
          },
          threadId,
        }),
      );

      expect(result).toBeInstanceOf(Response);
      const messages = streamChatMock.mock.calls.at(0)?.[0].messages;
      // Entity B is re-minted from its stored id. It must not take `ent_1`,
      // which the model already holds for entity A.
      const userText = messageText(
        messages?.find((message) => message.role === "user"),
      );
      expect(userText).toContain("#stella-entity-ref=ent_2");
      expect(userText).not.toContain("#stella-entity-ref=ent_1");
      expect(
        messageText(messages?.find((message) => message.role === "assistant")),
      ).toContain("ent_1");
      // `ent_1` names entity A where the thread knows it, and nothing (a
      // loud unknown-ref failure) where it cannot know it: never entity B.
      const resolved = builtRegistries
        .at(-1)
        ?.resolveEntityRefTargets(["ent_1"]);
      expect(resolved === undefined ? undefined : Result.isOk(resolved)).toBe(
        KEEPS_ENT_1[bindingStore],
      );
      if (resolved !== undefined && Result.isOk(resolved)) {
        expect(resolved.value).toEqual([
          { entityId: ids.entityA1, workspaceId: ids.wsA1 },
        ]);
      }
    },
  );

  test("storing a held spelling for another target fails the write", async () => {
    const { threadId } = await seedAwaitingTurn(BINDING_STORE.thread);
    const bindingTo = (entityId: SafeId<"entity">) =>
      ({
        kind: "entity",
        ref: "ent_1",
        entity: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
        workspace: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: ids.wsA1 }),
      }) satisfies ChatRefBinding;
    const record = async (binding: ChatRefBinding) =>
      await Result.tryPromise({
        try: async () =>
          await safeDb(
            async (tx) =>
              await recordChatThreadNamesOnTx({
                added: { refBindings: [binding], toolCallIds: [] },
                read: {
                  refBindings: [],
                  retiredRefs: [],
                  source: "ledger",
                  toolCallIds: [],
                },
                threadId,
                tx,
              }),
          ),
        catch: (error: unknown) => error,
      });

    // The same target again is what the ledger already holds.
    const same = await record(bindingTo(ids.entityA1));
    expect(Result.isOk(same) && Result.isOk(same.value)).toBe(true);
    const other = await record(bindingTo(ids.entityA2));
    // The failure surfaces as a thrown panic or as the transaction's error.
    const failure = Result.isError(other) ? other.error : other.value;
    expect(Bun.inspect(failure)).toContain("bound to a second target");
  });
});
