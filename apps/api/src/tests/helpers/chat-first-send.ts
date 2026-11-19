import { panic } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendRequest as ContractChatSendRequest } from "@stll/api-contract/chat";
import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  agentSkills,
  caseLawDecisions,
  caseLawSources,
  chatMessages,
  chatThreads,
  fileChatThreads,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { chatSafePromptText } from "@/api/handlers/chat/chat-prompt";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import getMessages from "@/api/handlers/chat/messages/list";
import resolveFileThread from "@/api/handlers/chat/resolve-file-thread";
import rotateTemplateThread from "@/api/handlers/chat/rotate-template-thread";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import type { streamChat } from "@/api/handlers/chat/stream-chat";
import renameThread from "@/api/handlers/chat/threads/rename";
import updateThread from "@/api/handlers/chat/threads/update";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import type { ChatPart } from "@/api/handlers/chat/types";
import updateThreadModel from "@/api/handlers/chat/update-thread-model";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { unwrapStatus } from "@/api/http/status";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { encodeChatModelSelection } from "@/api/lib/chat-model-selection";
import { isReadyGeneratedDocumentDraft } from "@/api/lib/chat/created-draft";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import type {
  LegislationPublicReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { sseResponse } from "@/api/lib/sse";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { HELD_TEST_STREAM_BINDING } from "@/api/tests/helpers/sse-stream-binding";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withPublicLawReaderRole } from "@/api/tests/pglite-test-db";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// One real chat send path, from the settings writes a draft makes before its
// first message to the system prompt that send builds. Only the provider
// stream is replaced: everything up to the provider request, the database and
// the prompt builder included, is the production code.

/** Every send-request field that carries an open document or skill. */
export type ChatSendActiveField = Extract<
  keyof ContractChatSendRequest,
  `active${string}`
>;

export type ChatSendScope = "global" | "workspace";

/** What a send carries besides its message. */
export type CarriedSendContext = Partial<
  Pick<ChatSendRequest, ChatSendActiveField | "contextMatterIds">
>;

const FIRST_SEND_ORG_AI_CONFIG = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
  decision: null,
} satisfies OrgAIConfig;

/** Thread-level model picks the picker can store for this organization. */
export const PICKABLE_CHAT_MODELS = [
  null,
  encodeChatModelSelection({ provider: "openai", modelId: "gpt-5.4-mini" }),
  encodeChatModelSelection({ provider: "openai", modelId: "gpt-5.4" }),
] as const;

type StreamCall = Parameters<typeof streamChat>[0];

/**
 * The provider stream stand-in: it records what the send handed the provider
 * and answers with an empty stream. The harness settles each run itself, so a
 * thread takes its next message within one test.
 */
const createRecordingStream = () => {
  const calls: StreamCall[] = [];
  const streamResponse = async (props: StreamCall) => {
    calls.push(props);
    const source = new ReadableStream<Uint8Array>({
      start: (controller) => controller.close(),
    });
    // Settle the source before handing reader ownership to the heartbeat.
    const reader = source.getReader();
    try {
      await reader.closed;
    } finally {
      reader.releaseLock();
    }
    return {
      type: "streaming",
      response: sseResponse(source, HELD_TEST_STREAM_BINDING),
    } as const;
  };
  return { calls, streamResponse };
};

export type HandlerOutcome =
  { ok: true; value: unknown } | { ok: false; status: number; body: unknown };

/** A handler's answer: its value, or the error status it answered with. */
const outcomeOf = (answer: unknown): HandlerOutcome => {
  if (answer instanceof Response) {
    return answer.ok
      ? { ok: true, value: answer }
      : { ok: false, status: answer.status, body: undefined };
  }
  const { code, value } = unwrapStatus(answer);
  if (code !== undefined && code >= 400) {
    return { ok: false, status: code, body: value };
  }
  return { ok: true, value };
};

const RUN = Bun.randomUUIDv7().slice(-12);

/** The seeded installed skill a send can name by id. */
const INSTALLED_SKILL = {
  slug: `first-send-review-${RUN}`,
  body: `Apply the first-send review methodology ${RUN}.`,
};

const DECISION_CASE_NUMBER = `31 Cdo ${RUN}/2024`;
const STATUTE_TITLE = `Act on first-send fixtures ${RUN}`;
const DRAFT_FILE_NAME = `Generated draft ${RUN}.docx`;
const TEMPLATE_FILE_NAME = "a.docx";
const ACTIVE_FILE_NAME = `Lease agreement ${RUN}.docx`;
const EXTERNAL_TITLE = `External source ${RUN}`;

export type FirstSendHarness = Awaited<
  ReturnType<typeof createFirstSendHarness>
>;

/**
 * Seeds the corpus rows, skill and draft origin every active field needs and
 * returns the real handlers bound to the RLS fixture's first member.
 */
export const createFirstSendHarness = async ({
  ids,
  testDb,
}: {
  ids: TestIds;
  testDb: TestDatabase;
}) => {
  const stream = createRecordingStream();
  const scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  const safeDb: SafeDb = toSafeDbMock(scopedDb);

  const caseLawDb: CaseLawPublicReadDb = Object.assign(
    async <T>(read: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
      await withPublicLawReaderRole(
        testDb,
        async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
      ),
    caseLawPublicReadDb,
  );
  const legislationDb: LegislationPublicReadDb = Object.assign(
    async <T>(read: (tx: LegislationReadTransaction) => Promise<T>) =>
      await withPublicLawReaderRole(
        testDb,
        async (tx) => await read(asTestRaw<LegislationReadTransaction>(tx)),
      ),
    legislationPublicReadDb,
  );

  const sendMessage = createSendMessage({
    caseLawDb,
    compactMessagesForContext,
    createRefRegistry: createChatRefRegistry,
    indexThread: async () => undefined,
    legislationDb,
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
    streamResponse: stream.streamResponse,
    uploadMessageFiles: uploadMessageFilesWithRollback,
  });
  type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];

  const createdThreadIds = new Set<SafeId<"chatThread">>();
  const skillId = createSafeId<"agentSkill">();
  const caseSourceId = createSafeId<"caseLawSource">();
  const decisionId = createSafeId<"caseLawDecision">();
  const statuteSourceId = createSafeId<"legislationSource">();
  const statuteId = createSafeId<"legislationDocument">();
  const draftOriginThreadId = createSafeId<"chatThread">();
  const draftOriginMessageId = createSafeId<"chatMessage">();
  const draftToolCallId = `create-document-${RUN}`;
  createdThreadIds.add(draftOriginThreadId);

  await testDb.insert(agentSkills).values({
    id: skillId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    scope: "private",
    origin: "authored",
    slug: INSTALLED_SKILL.slug,
    name: "First-send review",
    description: "Skill a first send names by id.",
    metadata: {},
    contentHash: "0".repeat(64),
    body: INSTALLED_SKILL.body,
    enabled: true,
  });
  await testDb
    .insert(caseLawSources)
    .values(caseLawSourceRow({ id: caseSourceId, adapterKey: `fs-${RUN}` }));
  await testDb.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId: caseSourceId,
    caseNumber: DECISION_CASE_NUMBER,
    country: "CZE",
    court: "Nejvyšší soud",
    decisionDate: "2024-02-01",
    language: "cs",
    slug: `first-send-decision-${RUN}`,
    fulltext: "The court dismissed the appeal.",
  });
  await testDb.insert(legislationSources).values({
    id: statuteSourceId,
    adapterKey: `fs-${RUN}`,
    name: `First-send statutes ${RUN}`,
    descriptor: null,
  });
  await testDb.insert(legislationDocuments).values({
    id: statuteId,
    sourceId: statuteSourceId,
    eli: `test/first-send/${RUN}`,
    title: STATUTE_TITLE,
    country: "CZE",
    language: "cs",
    fulltext: "Section 1. This act applies to fixtures.",
    status: "current",
    documentAst: EMPTY_AST,
  });

  // The assistant turn that produced an unsaved generated draft, in a thread
  // whose embedded data comes from the second matter.
  const draftOutput = {
    destination: "draft" as const,
    fileName: DRAFT_FILE_NAME,
    success: true as const,
  };
  const draftParts = [
    {
      arguments: "{}",
      id: draftToolCallId,
      input: {},
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
      name: "create-document",
      output: draftOutput,
      state: "complete",
      type: "tool-call",
    },
    {
      content: JSON.stringify(draftOutput),
      state: "complete",
      toolCallId: draftToolCallId,
      type: "tool-result",
    },
  ] satisfies ChatPart[];
  const draftContent = toPersistedChatMessageContentV3({ data: draftParts });
  if (
    !isReadyGeneratedDocumentDraft({
      persistedContent: draftContent,
      fileName: DRAFT_FILE_NAME,
      toolCallId: draftToolCallId,
    })
  ) {
    panic("The draft origin fixture must be a ready generated draft");
  }
  await testDb.insert(chatThreads).values({
    id: draftOriginThreadId,
    organizationId: ids.orgA,
    title: "Draft origin",
    userId: ids.userA1,
    workspaceId: null,
    dataWorkspaceIds: [ids.wsA2],
  });
  await testDb.insert(chatMessages).values({
    content: draftContent,
    id: draftOriginMessageId,
    role: "assistant",
    threadId: draftOriginThreadId,
    userId: ids.userA1,
    workspaceId: null,
  });

  /** The data scope a draft-carrying send must inherit. */
  const draftOriginDataWorkspaceIds: readonly SafeId<"workspace">[] = [
    ids.wsA2,
  ];

  const workspaceIdOf = (scope: ChatSendScope) =>
    scope === "workspace" ? ids.wsA1 : null;

  const handlerContext = <TContext>({
    scope,
    fields,
  }: {
    scope: ChatSendScope;
    fields: Record<string, unknown>;
  }) =>
    createTestHandlerContext<TContext>({
      audit: async () => undefined,
      getAccessibleWorkspaces: async () => [
        { id: ids.wsA1, status: "active" },
        { id: ids.wsA2, status: "active" },
      ],
      getActiveWorkspaceIds: async () => [ids.wsA1, ids.wsA2],
      getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) =>
        workspaceId === ids.wsA1 || workspaceId === ids.wsA2
          ? { id: workspaceId, status: "active" }
          : null,
      orgAIConfig: FIRST_SEND_ORG_AI_CONFIG,
      pinServerValidatedWorkspaceId: () => false,
      safeDb,
      scopedDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1, email: "first-send@example.test" },
      ...(scope === "workspace" ? { workspaceId: ids.wsA1 } : {}),
      ...fields,
    });

  const scopeQuery = (scope: ChatSendScope) =>
    scope === "workspace" ? { workspaceId: ids.wsA1 } : {};

  /** The values each active field carries in these sends. */
  const activeValues = {
    activeDecision: { decisionId },
    activeDraft: {
      docxEditSnapshot: {
        blocks: [{ id: "p-1", kind: "paragraph", text: "Draft clause." }],
      },
      fileName: DRAFT_FILE_NAME,
      originChatMessageId: draftOriginMessageId,
      originChatThreadId: draftOriginThreadId,
      toolCallId: draftToolCallId,
    },
    activeExternal: {
      text: "Visible external wording.",
      title: EXTERNAL_TITLE,
      url: "https://example.test/source",
    },
    activeFile: { entityId: ids.entityA1, fileName: ACTIVE_FILE_NAME },
    activeSkill: { skillId, skillName: INSTALLED_SKILL.slug },
    activeStatute: { documentId: statuteId },
    activeTemplate: {
      fileName: TEMPLATE_FILE_NAME,
      templateId: ids.templateA,
    },
  } satisfies {
    [Field in ChatSendActiveField]-?: NonNullable<ChatSendRequest[Field]>;
  };

  /** A send context carrying one active field and nothing else. */
  const carryingOnly = {
    activeDecision: { activeDecision: activeValues.activeDecision },
    activeDraft: { activeDraft: activeValues.activeDraft },
    activeExternal: { activeExternal: activeValues.activeExternal },
    activeFile: { activeFile: activeValues.activeFile },
    activeSkill: { activeSkill: activeValues.activeSkill },
    activeStatute: { activeStatute: activeValues.activeStatute },
    activeTemplate: { activeTemplate: activeValues.activeTemplate },
  } satisfies Record<ChatSendActiveField, CarriedSendContext>;

  /** Text each active field's prompt section names its subject by. */
  const promptMarkers = {
    activeDecision: `The user is currently viewing case-law decision "${DECISION_CASE_NUMBER}"`,
    activeDraft: `ACTIVE UNSAVED DRAFT: The user is viewing and editing the generated DOCX draft "${DRAFT_FILE_NAME}"`,
    activeExternal: "ACTIVE EXTERNAL SOURCE:",
    activeFile: `ACTIVE FILE: The user is viewing "${ACTIVE_FILE_NAME}"`,
    activeSkill: "ACTIVE SKILL CONTEXT:",
    activeStatute: `The user is currently reading the act "${STATUTE_TITLE}"`,
    activeTemplate: `ACTIVE TEMPLATE: The user is authoring the reusable document template "${TEMPLATE_FILE_NAME}"`,
  } satisfies Record<ChatSendActiveField, string>;

  const newDraftThreadId = () => {
    const threadId = createSafeId<"chatThread">();
    createdThreadIds.add(threadId);
    return threadId;
  };

  const send = async ({
    carried,
    scope,
    text = "Help me with this.",
    threadId,
  }: {
    carried: CarriedSendContext;
    scope: ChatSendScope;
    text?: string;
    threadId: SafeId<"chatThread">;
  }) => {
    const message: ChatSendRequest["message"] = {
      id: createSafeId<"chatMessage">(),
      parts: [{ content: text, type: "text" }],
      role: "user",
    };
    const workspaceId = workspaceIdOf(scope);
    const forwardedProps = {
      contextMatterIds: [],
      ...carried,
      message,
      runId: `run-${message.id}`,
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId,
      ...(workspaceId === null ? {} : { workspaceId }),
    };
    const callsBefore = stream.calls.length;
    const result: unknown = await sendMessage.handler(
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
        getWorkspaceAccess: async (id: SafeId<"workspace">) =>
          id === ids.wsA1 || id === ids.wsA2 ? { id, status: "active" } : null,
        memberRole: sessionMemberRole("owner"),
        orgAIConfig: FIRST_SEND_ORG_AI_CONFIG,
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
        ...(workspaceId === null ? {} : { workspaceId }),
      }),
    );
    const outcome = outcomeOf(result);
    const call =
      stream.calls.length > callsBefore ? stream.calls.at(-1) : undefined;
    if (call !== undefined) {
      // No provider answers, so settle the turn here: the thread then holds
      // the stored user message and takes its next one.
      await call.run.fail("provider-error", true);
      if ((await call.run.settled) !== "stored") {
        panic("The harness could not settle the handed-over run");
      }
    }
    const systemPrompt =
      call === undefined
        ? undefined
        : `${chatSafePromptText(call.systemSafe)}${call.systemUntrusted}`;
    return { outcome, systemPrompt };
  };

  const setModel = async ({
    model,
    scope,
    threadId,
  }: {
    model: (typeof PICKABLE_CHAT_MODELS)[number];
    scope: ChatSendScope;
    threadId: SafeId<"chatThread">;
  }) =>
    outcomeOf(
      await updateThreadModel.handler(
        handlerContext<Parameters<typeof updateThreadModel.handler>[0]>({
          scope: "global",
          fields: {
            body: { model },
            params: { threadId },
            query: scopeQuery(scope),
          },
        }),
      ),
    );

  const setWebSearch = async ({
    enabled,
    scope,
    threadId,
  }: {
    enabled: boolean;
    scope: ChatSendScope;
    threadId: SafeId<"chatThread">;
  }) =>
    outcomeOf(
      await updateThread.handler(
        handlerContext<Parameters<typeof updateThread.handler>[0]>({
          scope: "global",
          fields: {
            body: { webSearchEnabled: enabled },
            params: { threadId },
            query: scopeQuery(scope),
          },
        }),
      ),
    );

  const rename = async ({
    scope,
    threadId,
    title,
  }: {
    scope: ChatSendScope;
    threadId: SafeId<"chatThread">;
    title: string;
  }) =>
    outcomeOf(
      await renameThread.handler(
        handlerContext<Parameters<typeof renameThread.handler>[0]>({
          scope: "global",
          fields: {
            body: { title },
            params: { threadId },
            query: scopeQuery(scope),
          },
        }),
      ),
    );

  /** What reopening the chat reads back, as the client loads it. */
  const reopen = async ({
    scope,
    threadId,
  }: {
    scope: ChatSendScope;
    threadId: SafeId<"chatThread">;
  }) =>
    outcomeOf(
      await getMessages.handler(
        handlerContext<Parameters<typeof getMessages.handler>[0]>({
          scope: "global",
          fields: {
            params: { threadId },
            query: { allowMissingThread: true, ...scopeQuery(scope) },
          },
        }),
      ),
    );

  /** Template studio's "new chat": a fresh global thread for the template. */
  const rotateTemplate = async (): Promise<SafeId<"chatThread">> => {
    const outcome = outcomeOf(
      await rotateTemplateThread.handler(
        handlerContext<Parameters<typeof rotateTemplateThread.handler>[0]>({
          scope: "global",
          fields: { body: { templateId: ids.templateA } },
        }),
      ),
    );
    const threadId = chatThreadIdOf(outcome);
    createdThreadIds.add(threadId);
    return threadId;
  };

  /** Opening the chat beside a matter file, optionally adopting a draft id. */
  const resolveFile = async (
    requestedThreadId?: SafeId<"chatThread">,
  ): Promise<SafeId<"chatThread">> => {
    const outcome = outcomeOf(
      await resolveFileThread.handler(
        handlerContext<Parameters<typeof resolveFileThread.handler>[0]>({
          scope: "workspace",
          fields: {
            body: {
              entityId: ids.entityA1,
              fieldId: ids.fileFieldA1,
              ...(requestedThreadId === undefined
                ? {}
                : { threadId: requestedThreadId }),
            },
          },
        }),
      ),
    );
    const threadId = chatThreadIdOf(outcome);
    createdThreadIds.add(threadId);
    return threadId;
  };

  const storedThread = async (threadId: SafeId<"chatThread">) =>
    await testDb.query.chatThreads.findFirst({
      where: { id: { eq: threadId } },
      columns: {
        activeSkill: true,
        chatModel: true,
        contextMatterIds: true,
        dataWorkspaceIds: true,
        subjectDecisionId: true,
        webSearchEnabled: true,
        workspaceId: true,
      },
    });

  /** Remove every thread a run made, and the file mapping it may have left. */
  const resetThreads = async () => {
    await testDb
      .delete(fileChatThreads)
      .where(
        and(
          eq(fileChatThreads.userId, ids.userA1),
          eq(fileChatThreads.entityId, ids.entityA1),
          eq(fileChatThreads.fieldId, ids.fileFieldA1),
        ),
      );
    const removable = [...createdThreadIds].filter(
      (threadId) => threadId !== draftOriginThreadId,
    );
    if (removable.length > 0) {
      await testDb
        .delete(chatThreads)
        .where(inArray(chatThreads.id, removable));
    }
    for (const threadId of removable) {
      createdThreadIds.delete(threadId);
    }
  };

  const dispose = async () => {
    await resetThreads();
    await testDb
      .delete(chatThreads)
      .where(eq(chatThreads.id, draftOriginThreadId));
    await testDb.delete(agentSkills).where(eq(agentSkills.id, skillId));
    await testDb
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId));
    await testDb
      .delete(caseLawSources)
      .where(eq(caseLawSources.id, caseSourceId));
    await testDb
      .delete(legislationDocuments)
      .where(eq(legislationDocuments.id, statuteId));
    await testDb
      .delete(legislationSources)
      .where(eq(legislationSources.id, statuteSourceId));
  };

  return {
    activeValues,
    carryingOnly,
    dispose,
    draftOriginDataWorkspaceIds,
    newDraftThreadId,
    promptMarkers,
    rename,
    reopen,
    resetThreads,
    resolveFile,
    rotateTemplate,
    send,
    setModel,
    setWebSearch,
    storedThread,
    workspaceIdOf,
  };
};

const chatThreadIdOf = (outcome: HandlerOutcome): SafeId<"chatThread"> => {
  if (
    outcome.ok &&
    typeof outcome.value === "object" &&
    outcome.value !== null &&
    "threadId" in outcome.value &&
    typeof outcome.value.threadId === "string"
  ) {
    return asTestRaw<SafeId<"chatThread">>(outcome.value.threadId);
  }
  return panic(
    `The thread-creating route returned no thread: ${JSON.stringify(outcome)}`,
  );
};
