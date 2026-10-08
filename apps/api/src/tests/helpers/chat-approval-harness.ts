import { Value } from "@sinclair/typebox/value";
import { toolDefinition } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_TURN_ID_HEADER, CHAT_TURN_INTENT } from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatTurns } from "@/api/db/schema";
import { startChatExecutionAdmission } from "@/api/handlers/chat/chat-execution-admission";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import { agUiSendMessageBodySchema } from "@/api/handlers/chat/chat-schema";
import type {
  ChatSendRequest,
  IncomingUserContext,
} from "@/api/handlers/chat/chat-schema";
import { reapOwnerlessChatTurnOnTx } from "@/api/handlers/chat/chat-turn-persistence";
import { relinquishChatTurnRuns } from "@/api/handlers/chat/chat-turn-run";
import {
  decodeMessagePageCursor,
  loadChatMessagePage,
} from "@/api/handlers/chat/message-page";
import type { ChatMessagePage } from "@/api/handlers/chat/message-page";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import type { SendMessageDependencies } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import { streamChat } from "@/api/handlers/chat/stream-chat";
import type { StreamChatFinishEvent } from "@/api/handlers/chat/stream-chat";
import { createStellaMcpToolSource } from "@/api/handlers/chat/tools/external-mcp-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import cancelTurn from "@/api/handlers/chat/turns/cancel";
import { joinChatTurn, probeChatTurn } from "@/api/handlers/chat/turns/resume";
import type { ChatPart } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type ChatRefRegistry,
  createChatRefRegistry,
} from "@/api/lib/chat/ref-registry";
import { readChatThreadNames } from "@/api/lib/chat/thread-names";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createReapOwnerlessChatTurnsTask } from "@/api/lib/scheduler/tasks/chat-turn-reaper";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import type { anonymizeTextFields } from "@/api/mcp/anonymization";
import type {
  ChatHarnessProfile,
  ChatHarnessPhase,
} from "@/api/tests/helpers/chat-harness-profile";
import {
  findLiveViewViolations,
  findUnservedSnapshotMessages,
  findUnstoredWireResults,
  findWireIdentityViolations,
} from "@/api/tests/helpers/chat-live-reload-invariants";
import type { DeliveredInterrupt } from "@/api/tests/helpers/chat-live-reload-invariants";
import { relayLiveResponse } from "@/api/tests/helpers/chat-live-response";
import {
  deliveredInterrupts,
  loadReloadPage,
  loadReloadView,
  readClientStreamChunks,
} from "@/api/tests/helpers/chat-live-view";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type {
  ChatOracleId,
  OracleViolation,
} from "@/api/tests/helpers/chat-oracles";
import { createRefStabilityLedger } from "@/api/tests/helpers/chat-ref-stability";
import { createTornDownRequest } from "@/api/tests/helpers/chat-request-teardown";
import type { TornDownRequest } from "@/api/tests/helpers/chat-request-teardown";
import { drainResponse } from "@/api/tests/helpers/chat-round-trip";
import { installScriptedProvider } from "@/api/tests/helpers/chat-scripted-provider";
import type { ScriptedRun } from "@/api/tests/helpers/chat-scripted-provider";
import {
  offeredInteractionsOf,
  readThreadInvariantSnapshot,
  threadInvariantViolationsOf,
} from "@/api/tests/helpers/chat-thread-invariants";
import type { ThreadInvariantSnapshot } from "@/api/tests/helpers/chat-thread-invariants";
import {
  findLiveOutcomeViolations,
  findTurnOutcomeViolations,
} from "@/api/tests/helpers/chat-turn-outcome";
import {
  createWebChatClient,
  loadWebChat,
} from "@/api/tests/helpers/chat-web-client";
import type {
  WebChatClient,
  WebChatContext,
} from "@/api/tests/helpers/chat-web-client";
import { findTranscriptViolations } from "@/api/tests/helpers/provider-request-transcript";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { rootPoolConnectionCount } from "@/api/tests/test-database-environment";

// A real chat round trip: the production `send-message` handler and
// `streamChat` pipeline, with a scripted model behind the adapter seam, one
// counted approval-gated external tool, and the web app's own chat runtime as
// the browser. A web client (`openWebClient`) posts what its live view holds
// and answers only the cards that view shows. After every send the stored
// thread and the wire are checked, and `checkWebClient` compares what the
// page shows live with what a reload shows. Every request is torn down once
// the handler hands its response back, so every conversation also checks
// that the turn's run does not depend on it.

export const APPROVAL_TOOL_NAME = "mcp__external__delete";
/**
 * A built-in read tool that runs without asking: every external tool needs an
 * approval, so the plain server tool comes from Stella's own catalog.
 */
export const PLAIN_TOOL_NAME = "list_templates";
export const PLAIN_TOOL_ARGUMENTS = "{}";
/**
 * A server tool, behind an approval like every external tool, whose output
 * shows the model document refs minted by the request's own registry, as a
 * direct tool does (`create_matter_document`, `save_document`). Registered
 * only when a harness asks for it.
 */
export const DIRECT_REF_TOOL_NAME = "mcp__external__list_documents";

/** Arguments the scripted provider passes to the approval-gated tool. */
export const approvalToolArguments = (name: string): string =>
  JSON.stringify({ name });

/** The model the harness's organization answers chat turns with. */
export const HARNESS_CHAT_MODEL_ID = "gpt-5.4-mini";

const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: HARNESS_CHAT_MODEL_ID },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
  decision: null,
} satisfies OrgAIConfig;

type InterruptResume = {
  interruptId: string;
  payload: unknown;
  status: "resolved";
}[];

export type ApprovalCall = Extract<ChatPart, { type: "tool-call" }> & {
  approval: { id: string; needsApproval: boolean };
};

/** A thread's first message page, as the messages endpoint serves it. */
export type RecordedPage = Pick<
  ChatMessagePage,
  "activeTurnId" | "lastActivityAt" | "olderCursor"
> & { messages: unknown[] };

/** One request a page sent on a recorded thread, as the route answered it. */
export type RecordedExchange = {
  /** Whether the page read the response to its end, the server ended it
   *  once the page's Stop reached the server, the connection closed first
   *  (the page closed it, or it dropped), or no response came at all (the
   *  process serving it died). */
  ended: "complete" | "connection-lost" | "disconnected" | "stopped";
  /** The thread's first message page once the request had settled. */
  page: RecordedPage;
  /** The JSON body the page posted. */
  request: unknown;
  /** The SSE body the page read, or the route's refusal. */
  response: { body: string; status: number; turnId: string | null };
};

const CHAT_ROUTE_PATH = "/v1/chat";
/** The Stop route: `/v1/chat/threads/:threadId/turns/:turnId/cancel`. */
const CHAT_TURN_CANCEL_PATH =
  /^\/v1\/chat\/threads\/(?<threadId>[^/]+)\/turns\/(?<turnId>[^/]+)\/cancel$/u;
const LIVE_TURN_STATUSES = ["accepted", "running"] as const;
const MAX_BARRIER_POLLS = 2000;
/** The checks a hand-built send answers for: the stored thread's, the
 *  requests the provider was handed, and the run's independence from its
 *  request. */
const STORED_THREAD_ORACLES: ReadonlySet<ChatOracleId> = new Set([
  CHAT_ORACLE.providerTranscriptSettled,
  CHAT_ORACLE.persistedCallsSettled,
  CHAT_ORACLE.persistedPendingOwned,
  CHAT_ORACLE.persistedRunIdentity,
  CHAT_ORACLE.persistedRefsStable,
  CHAT_ORACLE.persistedTurnOutcome,
  CHAT_ORACLE.persistedTurnSettles,
  CHAT_ORACLE.runOutlivesRequest,
]);
/** How a turn ends when something cut its run short: a response read to its
 *  end, with no Stop, cannot have ended that way. */
const CUT_SHORT_REASONS: ReadonlySet<string> = new Set([
  "client-disconnected",
  "user-stop",
]);

/** The page's connection dropping because the process serving it died. */
class ChatConnectionLostError extends TaggedError("ChatConnectionLostError")<{
  message: string;
}> {}

/** The HTTP answer a route's status response makes (a refusal, or a Stop's
 *  answer), as the browser sees it. */
const statusResponse = (answer: unknown): Response => {
  if (answer instanceof Response) {
    return answer;
  }
  const status: unknown =
    typeof answer === "object" && answer !== null
      ? Reflect.get(answer, "code")
      : undefined;
  const body: unknown =
    typeof answer === "object" && answer !== null
      ? Reflect.get(answer, "response")
      : undefined;
  return new Response(JSON.stringify(body ?? { message: "Refused" }), {
    headers: { "Content-Type": "application/json" },
    status: typeof status === "number" ? status : 500,
  });
};

/**
 * Where the harness's model calls are answered: the scripted provider by
 * default, or a real adapter fed recorded provider responses.
 */
export type HarnessModel = Pick<
  ReturnType<typeof installScriptedProvider>,
  | "modelOptionsOf"
  | "promptLedgerOf"
  | "promptsOf"
  | "restore"
  | "script"
  | "stalled"
  | "takeFindings"
  | "takeRequests"
>;

export const createApprovalHarness = ({
  beforeTurnSettles,
  boundaryAnonymizer,
  ids,
  model,
  organizationAIConfig = orgAIConfig,
  promptCachingEnabled = false,
  profile,
  safeDb,
  scopedDb,
  sources = {},
  testDb,
  user,
  withDirectRefTool = false,
}: {
  /**
   * Replaces the anonymizer an anonymized turn's provider boundary calls, so a
   * test can make it fail. The real pipeline by default.
   */
  boundaryAnonymizer?: typeof anonymizeTextFields | undefined;
  /**
   * Runs once a turn's stream has ended and before the send stores its
   * outcome, with the outcome the run proposes: what a stop or another owner
   * does there races the turn's own settlement.
   */
  beforeTurnSettles?:
    | ((props: {
        outcome: StreamChatFinishEvent["outcome"];
        threadId: SafeId<"chatThread">;
      }) => Promise<void>)
    | undefined;
  ids: TestIds;
  /**
   * Who sends, and the profile their page sends with each message
   * (`userContext`); the organization's first member, with none, by default.
   * `safeDb` and `scopedDb` must be scoped to the same user.
   */
  user?:
    | { context?: IncomingUserContext | undefined; id: SafeId<"user"> }
    | undefined;
  /**
   * What a turn can draw on beyond Stella's own tools: the matters in its
   * context, the organization's web search and URL fetcher, and the
   * organization's external tools listed for lazy discovery. None by
   * default.
   */
  sources?: {
    contextMatterIds?: readonly SafeId<"workspace">[] | undefined;
    lazyExternalTools?:
      | Parameters<typeof createStellaMcpToolSource>[0]["sourceTools"]
      | undefined;
    web?: Awaited<
      ReturnType<SendMessageDependencies["loadWebSearchProviders"]>
    >;
  };
  /** The organization's prompt caching setting; off by default. */
  promptCachingEnabled?: boolean | undefined;
  /** Registers `DIRECT_REF_TOOL_NAME` too. */
  withDirectRefTool?: boolean | undefined;
  /** Defaults to the scripted provider. */
  model?: HarnessModel | undefined;
  /** The organization's model selection; defaults to the harness's own. */
  organizationAIConfig?: OrgAIConfig | undefined;
  profile?: ChatHarnessProfile | undefined;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  testDb: TestDatabase;
}) => {
  const measure = async <T>(
    phase: ChatHarnessPhase,
    operation: () => Promise<T>,
  ): Promise<T> =>
    profile === undefined
      ? await operation()
      : await profile.measure(phase, operation);
  const userId = user?.id ?? ids.userA1;
  // Every database access of a turn goes to the test database; one that
  // reaches the shared pools escaped it, and fails the test at `close`.
  const rootPoolConnectionsAtStart = rootPoolConnectionCount();
  const provider = model ?? installScriptedProvider();
  const executions: string[] = [];
  const approvalTool = toolDefinition({
    name: APPROVAL_TOOL_NAME,
    description: "Server tool behind an approval",
    // The optional field is what strict provider schemas send as null, and
    // what a route that fills every field sends as "" (a note is never empty).
    inputSchema: toTanStackToolSchema(
      v.object({
        name: v.string(),
        note: v.optional(v.pipe(v.string(), v.minLength(1))),
      }),
    ),
    needsApproval: true,
  }).server(async ({ name }) => {
    executions.push(name);
    return await Promise.resolve({ deleted: name });
  });
  const refLedger = createRefStabilityLedger();
  /** The registry the newest request built: the one a running tool uses. */
  let requestRegistry: ChatRefRegistry | undefined;
  const directRefTool = toolDefinition({
    name: DIRECT_REF_TOOL_NAME,
    description: "Lists the documents the user can access, by ref",
    inputSchema: toTanStackToolSchema(v.object({})),
    needsApproval: true,
  }).server(async () => {
    const registry =
      requestRegistry ?? panic("A tool runs inside a request that built one");
    return await Promise.resolve({
      documents: [
        { entityId: ids.entityA2, name: "entityA2", workspaceId: ids.wsA2 },
        { entityId: ids.entityA1, name: "entityA1", workspaceId: ids.wsA1 },
      ].map(({ entityId, name, workspaceId }) => ({
        id: registry.toEntityRef({ entityId, workspaceId }),
        name,
      })),
    });
  });
  /** Runs once, when the next send has read its thread and is about to
   *  accept its turn. */
  let nextAcceptanceRace: (() => Promise<void>) | undefined;
  const sendMessageDependencies = {
    // Admission is the last step before acceptance: the thread and its
    // history are read, and no turn is owned yet.
    startAdmission: async (options) => {
      const race = nextAcceptanceRace;
      nextAcceptanceRace = undefined;
      await race?.();
      return await startChatExecutionAdmission(options);
    },
    indexThread: async () => await Promise.resolve(undefined),
    // An approved write reads the member's role again when it runs; read it
    // from this test's database, not the shared pools.
    resolveCurrentMembership: async (lookup) =>
      await resolveMemberAuthorization(lookup, testDb),
    loadExternalMcpTools: async () => {
      const close = async () => await Promise.resolve(undefined);
      return await Promise.resolve({
        close,
        connectors: [],
        source: createStellaMcpToolSource({
          closeClients: close,
          sourceTools: sources.lazyExternalTools ?? {},
        }),
        tools: {
          [APPROVAL_TOOL_NAME]: approvalTool,
          ...(withDirectRefTool
            ? { [DIRECT_REF_TOOL_NAME]: directRefTool }
            : {}),
        },
      });
    },
    loadWebSearchProviders: async () =>
      await Promise.resolve(
        sources.web ?? { urlFetcher: null, webSearchProvider: null },
      ),
    rollbackSideEffects: rollbackUnpersistedChatSideEffects,
    compactMessagesForContext,
    streamResponse:
      boundaryAnonymizer === undefined && beforeTurnSettles === undefined
        ? streamChat
        : async (props) =>
            await streamChat({
              ...props,
              ...(beforeTurnSettles === undefined
                ? {}
                : {
                    onFinish: async (event) => {
                      await beforeTurnSettles({
                        outcome: event.outcome,
                        threadId: props.threadId,
                      });
                      return await props.onFinish(event);
                    },
                  }),
              thirdPartyBoundary:
                boundaryAnonymizer !== undefined &&
                props.thirdPartyBoundary.type === "anonymized"
                  ? {
                      ...props.thirdPartyBoundary,
                      anonymizeFields: boundaryAnonymizer,
                    }
                  : props.thirdPartyBoundary,
            }),
    uploadMessageFiles: uploadMessageFilesWithRollback,
  } satisfies Omit<SendMessageDependencies, "createRefRegistry">;
  /** Per thread: the send handler, recording each request's ref registry. */
  const handlers = new Map<string, ReturnType<typeof createSendMessage>>();
  const sendMessageOf = (threadId: string) => {
    const known = handlers.get(threadId);
    if (known !== undefined) {
      return known;
    }
    const created = createSendMessage({
      ...sendMessageDependencies,
      createRefRegistry: (bindings, retired) => {
        requestRegistry = createChatRefRegistry(bindings, retired);
        return refLedger.track(threadId, requestRegistry);
      },
    });
    handlers.set(threadId, created);
    return created;
  };
  type SendMessageCtx = Parameters<
    ReturnType<typeof createSendMessage>["handler"]
  >[0];
  type SendBody = SendMessageCtx["body"];
  const bodyByContext = new WeakMap<SendMessageCtx, SendBody>();
  const requestByContext = new WeakMap<SendMessageCtx, TornDownRequest>();

  /** The handler context the route builds around a validated body. */
  const contextFromBody = (
    body: SendBody,
    signal?: AbortSignal,
  ): SendMessageCtx => {
    const request = createTornDownRequest({
      signal,
      url: "http://localhost/v1/chat/send",
    });
    if (sources.contextMatterIds !== undefined) {
      // The matters the page's context names, as its composer sends them
      // (TanStack mirrors the forwarded props as `data`).
      const contextMatterIds = [...sources.contextMatterIds];
      Object.assign(body.forwardedProps, { contextMatterIds });
      Object.assign(body.data, { contextMatterIds });
    }
    if (user?.context !== undefined) {
      // The profile the page sends with every message.
      const userContext = { ...user.context };
      Object.assign(body.forwardedProps, { userContext });
      if (typeof body.data === "object") {
        Object.assign(body.data, { userContext });
      }
    }
    const ctx = asTestRaw<SendMessageCtx>({
      body,
      // A recorder reads the request it is built for.
      createAuditRecorder: () => {
        request.request.headers.get("user-agent");
        return async () => await Promise.resolve();
      },
      getAccessibleWorkspaces: async () =>
        await Promise.resolve([
          { id: ids.wsA1, status: "active" },
          { id: ids.wsA2, status: "active" },
        ]),
      getActiveWorkspaceIds: async () =>
        await Promise.resolve([ids.wsA1, ids.wsA2]),
      getWorkspaceAccess: async () => await Promise.resolve(null),
      memberRole: sessionMemberRole("owner"),
      orgAIConfig: organizationAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu",
      pinServerValidatedWorkspaceId: () => false,
      promptCachingEnabled,
      recordAuditEvent: async () => await Promise.resolve(),
      request: request.request,
      route: "/v1/chat/send",
      safeDb,
      scopedDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: userId },
    });
    bodyByContext.set(ctx, body);
    requestByContext.set(ctx, request);
    return ctx;
  };

  const requestOf = (ctx: SendMessageCtx): TornDownRequest =>
    requestByContext.get(ctx) ??
    panic("Send contexts come from this harness's contextFromBody");

  /**
   * The route's answer to `ctx`. Once the handler hands its response back,
   * the request is over: it is torn down before anything reads the response.
   */
  const handle = async (ctx: SendMessageCtx) =>
    await measure("action", async () => {
      const body =
        bodyByContext.get(ctx) ??
        panic("Send contexts come from this harness's contextFromBody");
      const result = await sendMessageOf(body.threadId).handler(ctx);
      requestOf(ctx).tearDown();
      return result;
    });

  /**
   * `chat.run.outlives-request`: reads of the request after its response,
   * and a turn cut short although its response was read to its end without a
   * Stop, which only the request's end could have done; and
   * `chat.persisted.run-identity`: the turn the response names holds the run
   * id its request posted.
   */
  const findRunViolations = ({
    ctx,
    ended,
    snapshot,
    turnId,
  }: {
    ctx: SendMessageCtx;
    ended: RecordedExchange["ended"];
    snapshot: ThreadInvariantSnapshot;
    turnId: string | null;
  }): OracleViolation[] => {
    const reads = requestOf(ctx).readsAfterResponse();
    const turn =
      turnId === null
        ? undefined
        : snapshot.turns.find(({ id }) => id === turnId);
    const reason =
      ended === "complete"
        ? (turn?.interruptionReason ?? turn?.cancellationReason)
        : undefined;
    const { runId } = bodyByContext.get(ctx) ?? panic("Unknown send context");
    return [
      ...violationsOf(CHAT_ORACLE.runOutlivesRequest, [
        ...reads.map((read) => ({ readAfterResponse: read })),
        ...(reason !== undefined &&
        reason !== null &&
        CUT_SHORT_REASONS.has(reason)
          ? [{ cutShortAfterCompleteResponse: { reason, turnId } }]
          : []),
      ]),
      ...violationsOf(
        CHAT_ORACLE.persistedRunIdentity,
        turn !== undefined && turn.runId !== runId
          ? [{ expectedRunId: runId, storedRunId: turn.runId, turnId }]
          : [],
      ),
    ];
  };

  /** A request built by hand rather than by a web client. */
  const sendContext = ({
    message,
    resume,
    runId,
    threadId,
  }: {
    message: ChatSendRequest["message"];
    /** A continuation names the interrupted run it resumes. */
    resume?: { interruptedRunId: string; items: InterruptResume } | undefined;
    runId: string;
    threadId: SafeId<"chatThread">;
  }): SendMessageCtx => {
    const continuation =
      resume === undefined
        ? {}
        : { parentRunId: resume.interruptedRunId, resume: resume.items };
    const forwardedProps = {
      contextMatterIds: [],
      message,
      runId,
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId,
      ...continuation,
    };
    return contextFromBody(
      asTestRaw<SendBody>({
        threadId,
        runId: forwardedProps.runId,
        state: {},
        messages: [message],
        tools: [],
        context: [],
        forwardedProps,
        data: forwardedProps,
        ...continuation,
      }),
    );
  };

  /**
   * Barrier: resolves once no turn on `threadId` is still accepted or
   * running, polled on the turn rows rather than on a clock. A turn that
   * never gets there is the `chat.persisted.turn-settles` finding.
   */
  const awaitSettledTurns = async (
    threadId: SafeId<"chatThread">,
  ): Promise<OracleViolation[]> =>
    await measure("settlement", async () => {
      let live: { id: string; status: string }[] = [];
      for (let poll = 0; poll < MAX_BARRIER_POLLS; poll += 1) {
        live = await testDb
          .select({ id: chatTurns.id, status: chatTurns.status })
          .from(chatTurns)
          .where(
            and(
              eq(chatTurns.threadId, threadId),
              inArray(chatTurns.status, [...LIVE_TURN_STATUSES]),
            ),
          );
        if (live.length === 0) {
          return [];
        }
        // Yield to the work settling the turn before looking again.
        await Bun.sleep(1);
      }
      return violationsOf(CHAT_ORACLE.persistedTurnSettles, live);
    });

  const reloadView = async (threadId: SafeId<"chatThread">) =>
    await measure(
      "oracle",
      async () => await loadReloadView({ safeDb, threadId, userId }),
    );
  const reloadPage = async (threadId: SafeId<"chatThread">) =>
    await measure(
      "oracle",
      async () => await loadReloadPage({ safeDb, threadId, userId }),
    );

  type CancelTurnCtx = Parameters<typeof cancelTurn.handler>[0];

  /** The Stop route for a web client: the real handler, answered as the
   *  route answers it. */
  const postCancelTurn = async ({
    threadId,
    turnId,
  }: {
    threadId: string;
    turnId: string;
  }): Promise<Response> => {
    const set = { headers: {}, status: 200 };
    const answer: unknown = await cancelTurn.handler(
      asTestRaw<CancelTurnCtx>({
        memberRole: sessionMemberRole("owner"),
        params: {
          threadId: toSafeId<"chatThread">(threadId),
          turnId: toSafeId<"chatTurn">(turnId),
        },
        request: new Request(
          `http://localhost/v1/chat/threads/${threadId}/turns/${turnId}/cancel`,
          { method: "POST" },
        ),
        route: "/v1/chat/threads/:threadId/turns/:turnId/cancel",
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        set,
        user: { id: userId },
      }),
    );
    // A refusal is a status response; an answer is the body, with the status
    // the handler set.
    return typeof answer === "object" && answer !== null && "turn" in answer
      ? Response.json(answer, { status: set.status })
      : statusResponse(answer);
  };

  const readSnapshot = async (threadId: SafeId<"chatThread">) =>
    await measure(
      "oracle",
      async () => await readThreadInvariantSnapshot({ db: testDb, threadId }),
    );

  const persistedViolationsOf = (
    snapshot: ThreadInvariantSnapshot,
  ): OracleViolation[] => {
    const {
      turnOutcomeMismatches,
      unownedPendingInteractions,
      unsettledToolCalls,
    } = threadInvariantViolationsOf(snapshot);
    return [
      ...violationsOf(
        CHAT_ORACLE.persistedPendingOwned,
        unownedPendingInteractions,
      ),
      ...violationsOf(CHAT_ORACLE.persistedCallsSettled, unsettledToolCalls),
      ...violationsOf(CHAT_ORACLE.persistedTurnOutcome, turnOutcomeMismatches),
    ];
  };

  const readThreadMessages = async (threadId: SafeId<"chatThread">) =>
    await measure("oracle", async () =>
      (
        await testDb
          .select({
            content: chatMessages.content,
            id: chatMessages.id,
            role: chatMessages.role,
          })
          .from(chatMessages)
          .where(eq(chatMessages.threadId, threadId))
          .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
      ).map(chatMessageFromPersisted),
    );

  /** Refs whose target moved, checked once a request of `threadId` settled. */
  const findUnstableRefs = async (
    threadId: SafeId<"chatThread">,
    snapshot: ThreadInvariantSnapshot,
  ): Promise<OracleViolation[]> => {
    // As the next request reads them: under the thread owner's row scope.
    const names = await safeDb(
      async (tx) => await readChatThreadNames({ threadId, tx }),
    );
    if (Result.isError(names)) {
      return panic("The thread's names failed to load", names.error);
    }
    const held = names.value.source === "ledger" ? names.value : null;
    return refLedger.check({
      ledger: {
        refs: new Set(held?.refBindings.map(({ ref }) => ref)),
        toolCallIds: new Set(held?.toolCallIds),
      },
      stored: snapshot.messages,
      threadId,
    });
  };

  /**
   * The `chat.turn.*` findings for the turn a request started or continued,
   * once it settled: its status against the parts its run added to the
   * message it names (`before` is the thread as the request found it), the
   * error a reload shows, and the chunks the page read.
   */
  const findSettledTurnViolations = async ({
    before,
    chunks,
    ended,
    snapshot,
    reload,
    threadId,
    turnId,
  }: {
    before: readonly { id: string; parts: readonly ChatPart[] }[];
    chunks: Parameters<typeof findTurnOutcomeViolations>[0]["chunks"];
    ended: RecordedExchange["ended"];
    snapshot: ThreadInvariantSnapshot;
    reload: Awaited<ReturnType<typeof reloadView>>;
    threadId: SafeId<"chatThread">;
    turnId: string | null;
  }): Promise<OracleViolation[]> =>
    await measure("oracle", async () => {
      // A streamed response names the turn it runs, and that turn is stored:
      // without it none of the checks below could run.
      if (turnId === null) {
        return violationsOf(CHAT_ORACLE.persistedRunIdentity, [
          { missingTurnHeader: CHAT_TURN_ID_HEADER, threadId },
        ]);
      }
      const turn = snapshot.turns.find(({ id }) => id === turnId);
      if (turn === undefined) {
        return violationsOf(CHAT_ORACLE.persistedRunIdentity, [
          { unstoredTurnId: turnId, threadId },
        ]);
      }
      const messageId = turn.assistantMessageId;
      const stored = snapshot.messages;
      const web = await loadWebChat();
      const message =
        messageId === null
          ? undefined
          : stored.find(({ id }) => id === messageId);
      const reloaded =
        messageId === null
          ? undefined
          : reload.find(({ id }) => id === messageId);
      return findTurnOutcomeViolations({
        after: message?.parts ?? null,
        before: before.find(({ id }) => id === messageId)?.parts ?? [],
        chunks,
        ended,
        reloadShowsError:
          reloaded !== undefined &&
          web.getChatAssistantTurnError(reloaded) !== undefined,
        storedOutcome: message?.metadata?.turnOutcome,
        turn,
      });
    });

  /**
   * Sends `ctx` and reads the response to its end, so its terminal
   * persistence runs; then checks the chunks the browser would read and,
   * past the turn barrier, the stored thread.
   */
  const sendAndCheck = async (
    ctx: SendMessageCtx,
    { readAfterSettling = false }: { readAfterSettling?: boolean } = {},
  ) =>
    await measure("action", async () => {
      const body =
        bodyByContext.get(ctx) ??
        panic("Send contexts come from this harness's sendContext");
      const threadId = body.threadId;
      const before = await readThreadMessages(threadId);
      const result = await handle(ctx);
      if (!(result instanceof Response && result.ok)) {
        return { rejection: result, status: "rejected" } as const;
      }
      // Unread, the run still ends on its own: nothing it does waits on the page.
      const settledUnread = readAfterSettling
        ? await awaitSettledTurns(threadId)
        : [];
      const text = await drainResponse(result);
      const chunks = await readClientStreamChunks({
        response: new Response(text, { headers: result.headers }),
        runId: body.runId,
        threadId,
      });
      const unsettled = await awaitSettledTurns(threadId);
      const [snapshot, reload] = await Promise.all([
        readSnapshot(threadId),
        reloadView(threadId),
      ]);
      return {
        chunks,
        headers: result.headers,
        status: "streamed",
        text,
        violations: await measure("oracle", async () => [
          ...settledUnread,
          ...unsettled,
          ...findRunViolations({
            ctx,
            ended: "complete",
            snapshot,
            turnId: result.headers.get(CHAT_TURN_ID_HEADER),
          }),
          ...findWireIdentityViolations(chunks),
          ...findUnstoredWireResults({
            chunks,
            stored: reload,
          }),
          ...findUnservedSnapshotMessages({
            chunks,
            served: await readAllMessages(threadId),
          }),
          ...persistedViolationsOf(snapshot),
          ...(await findSettledTurnViolations({
            before,
            chunks,
            ended: "complete",
            snapshot,
            reload,
            threadId,
            turnId: result.headers.get(CHAT_TURN_ID_HEADER),
          })),
          ...(await findUnstableRefs(threadId, snapshot)),
          ...findTranscriptViolations(provider.takeRequests(threadId)),
        ]),
      } as const;
    });

  /**
   * A send from a hand-built context, the server's own request path: a
   * streamed response must leave the stored thread sound; any other handler
   * result is a rejection and is returned as-is for the assertion. The wire
   * and the page are a browser's concern, checked on the web-client path.
   */
  const send = async (
    ctx: SendMessageCtx,
    options?: { readAfterSettling?: boolean },
  ): Promise<
    { status: "streamed" } | { rejection: unknown; status: "rejected" }
  > => {
    const outcome = await sendAndCheck(ctx, options);
    if (outcome.status === "rejected") {
      return outcome;
    }
    const storedViolations = outcome.violations.filter(({ oracle }) =>
      STORED_THREAD_ORACLES.has(oracle),
    );
    if (storedViolations.length > 0) {
      panic(
        `The stored thread breaks an invariant: ${JSON.stringify(storedViolations)}`,
      );
    }
    return { status: "streamed" };
  };

  // --- The browser side -----------------------------------------------------

  /** Findings from web-client requests since the last `checkWebClient`. */
  const clientFindings: OracleViolation[] = [];
  /** Per thread: the interrupts its page received with the latest response. */
  const delivered = new Map<string, DeliveredInterrupt[]>();
  /** Per recorded thread: every request its pages sent, as answered. */
  const recordings = new Map<string, RecordedExchange[]>();
  /** Threads whose responses reach the page as the server writes them. */
  const liveThreads = new Set<string>();
  /** Per thread: drops the connection of the response still streaming. */
  const openConnections = new Map<string, () => void>();
  /** Threads whose streaming response the page has asked the server to
   *  stop. */
  const stoppingThreads = new Set<string>();
  let inFlight = 0;

  /** Threads whose next web request is served by a process that then dies. */
  const crashingThreads = new Set<string>();
  /** Reads of the responses a dying process left behind, still running. */
  const abandonedReads = new Set<Promise<string>>();

  const reapOwnerlessTurns = async () => {
    await createReapOwnerlessChatTurnsTask(reapOwnerlessChatTurnOnTx)(
      asTestRaw<SchedulerTaskContext>({
        db: testDb,
        logger: { info: () => undefined },
        signal: new AbortController().signal,
      }),
    );
  };

  /**
   * Serves `body` until the run reaches a stalling model call, then lets the
   * serving process die: nothing reads the rest of the response, the page's
   * connection drops, and the run never persists what it did after its last
   * write. The turn's lease is then expired, as a dead owner's would be.
   */
  const crashDuring = async (body: SendBody): Promise<Response> => {
    const threadId = body.threadId;
    const stalled = provider.stalled(threadId);
    // What the dying process sent the model and never stored is gone: the
    // thread's next request cannot repeat it.
    const prompts = provider.promptLedgerOf(threadId);
    const beforeCrash = prompts.mark();
    // The dying process never sees the page go away, so no signal reaches it.
    const result = await handle(contextFromBody(body));
    if (!(result instanceof Response && result.ok)) {
      return statusResponse(result);
    }
    // Reading the stream is what runs the turn; it stops at the stall. In
    // this process the run lives on, stalled, until `close` ends it.
    abandonedReads.add(drainResponse(result));
    await stalled;
    prompts.loseSince(beforeCrash);
    // The earliest lease the row allows: just after the turn was created.
    await testDb
      .update(chatTurns)
      .set({
        leaseExpiresAt: sql`${chatTurns.createdAt} + interval '1 millisecond'`,
      })
      .where(
        and(eq(chatTurns.threadId, threadId), eq(chatTurns.status, "running")),
      );
    // Durable clients keep joining until the dead owner's turn settles. Run
    // the scheduler tick explicitly instead of waiting on its wall clock.
    await reapOwnerlessTurns();
    throw new ChatConnectionLostError({ message: "Failed to fetch" });
  };

  const readPage = async (
    threadId: SafeId<"chatThread">,
    before?: SafeId<"chatMessage">,
  ): Promise<RecordedPage> => {
    const page = await loadChatMessagePage({
      safeDb,
      threadId,
      userId,
      before,
    });
    if (Result.isError(page)) {
      return panic("The thread's message page failed to load", page.error);
    }
    // The page as the browser receives it: a JSON body.
    return asTestRaw<RecordedPage>(await Response.json(page.value).json());
  };

  const readAllMessages = async (threadId: SafeId<"chatThread">) => {
    const messages: unknown[] = [];
    let page = await readPage(threadId);
    messages.push(...page.messages);
    while (page.olderCursor !== null) {
      const before = decodeMessagePageCursor(page.olderCursor);
      if (before === null) {
        return panic("The thread's message page returned an invalid cursor");
      }
      page = await readPage(threadId, before);
      messages.push(...page.messages);
    }
    return messages;
  };

  type RecordEnd = (
    exchange: Pick<RecordedExchange, "ended" | "response">,
  ) => Promise<void>;

  /**
   * Starts recording a request of a recorded thread, in the order the page
   * sent it; the returned call completes the entry once the request settles.
   */
  const beginRecord = (raw: SendBody): RecordEnd => {
    const recording = recordings.get(raw.threadId);
    if (recording === undefined) {
      return async () => {
        await Promise.resolve();
      };
    }
    const entry = asTestRaw<RecordedExchange>({ request: raw });
    recording.push(entry);
    return async (exchange) => {
      Object.assign(entry, exchange, { page: await readPage(raw.threadId) });
    };
  };

  /** Checks a response the page has read to wherever it ended. */
  const afterResponse = async ({
    before,
    ctx,
    ended,
    endRecord,
    raw,
    text,
    turnId,
  }: {
    /** The thread as the request found it. */
    before: readonly { id: string; parts: readonly ChatPart[] }[];
    ctx: SendMessageCtx;
    endRecord: RecordEnd;
    ended: RecordedExchange["ended"];
    raw: SendBody;
    text: string;
    turnId: string | null;
  }) =>
    await measure("oracle", async () => {
      // This parses the captured delivery, not a live connection. A partial
      // capture has no server to replay from; its SSE offsets must not trigger
      // the SDK reconnect engine while checking the chunks already received.
      const captured =
        ended === "complete" ? text : text.replace(/^id:.*\n/gmu, "");
      const chunks = await readClientStreamChunks({
        response: new Response(captured),
        runId: raw.runId,
        threadId: raw.threadId,
      });
      const unsettled = await awaitSettledTurns(raw.threadId);
      const [snapshot, reload] = await Promise.all([
        readSnapshot(raw.threadId),
        reloadView(raw.threadId),
      ]);
      clientFindings.push(
        ...unsettled,
        ...findRunViolations({ ctx, ended, snapshot, turnId }),
        ...findWireIdentityViolations(chunks),
        ...findUnstoredWireResults({
          chunks,
          stored: reload,
        }),
        ...findUnservedSnapshotMessages({
          chunks,
          served: await readAllMessages(raw.threadId),
        }),
        ...persistedViolationsOf(snapshot),
        ...(await findSettledTurnViolations({
          before,
          chunks,
          ended,
          snapshot,
          reload,
          threadId: raw.threadId,
          turnId,
        })),
        ...(await findUnstableRefs(raw.threadId, snapshot)),
      );
      delivered.set(raw.threadId, deliveredInterrupts(chunks));
      await endRecord({ ended, response: { body: text, status: 200, turnId } });
    });

  /**
   * A response handed to the page while the server is still writing it. It
   * ends when the server ends it, or when the page aborts its request or the
   * connection drops, which cancels the server's response the way a closed
   * socket does.
   */
  const streamLive = ({
    before,
    ctx,
    endRecord,
    raw,
    response,
    signal,
  }: {
    before: readonly { id: string; parts: readonly ChatPart[] }[];
    ctx: SendMessageCtx;
    endRecord: RecordEnd;
    raw: SendBody;
    response: Response;
    signal: AbortSignal | undefined;
  }): { done: Promise<void>; response: Response } => {
    const live = relayLiveResponse(
      response.body ?? panic("A streamed chat response has no body"),
    );
    const onAbort = () => {
      live.disconnect(new DOMException("The page aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    openConnections.set(raw.threadId, () => {
      live.disconnect(new TypeError("The connection dropped"));
    });
    const body = live.body;
    const settleResponse = async () => {
      const { ending, text } = await live.ended;
      signal?.removeEventListener("abort", onAbort);
      openConnections.delete(raw.threadId);
      const stopped = stoppingThreads.delete(raw.threadId);
      await afterResponse({
        before,
        ctx,
        endRecord,
        ended: ending === "complete" && stopped ? "stopped" : ending,
        raw,
        text,
        turnId: response.headers.get(CHAT_TURN_ID_HEADER),
      });
    };
    const done = settleResponse();
    return {
      done,
      response: new Response(body, { headers: response.headers }),
    };
  };

  /** The route's refusal, reported and recorded. */
  const refuse = async (endRecord: RecordEnd, rejection: unknown) => {
    clientFindings.push(
      ...violationsOf(CHAT_ORACLE.clientRequestsAccepted, [
        { refused: Bun.inspect(rejection) },
      ]),
    );
    const response = statusResponse(rejection);
    await endRecord({
      ended: "complete",
      response: {
        body: await response.clone().text(),
        status: response.status,
        turnId: response.headers.get(CHAT_TURN_ID_HEADER),
      },
    });
    return response;
  };

  /**
   * The route for the web client: the posted JSON is validated against the
   * route's body schema, sent to the real handler, checked, and its SSE body
   * (or the route's refusal) handed back. `done` settles once the response
   * has ended and been checked.
   */
  const postChatBody = async (
    raw: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ done: Promise<void>; response: Response }> => {
    if (!Value.Check(agUiSendMessageBodySchema, raw)) {
      const errors = [...Value.Errors(agUiSendMessageBodySchema, raw)]
        .slice(0, 3)
        .map(({ message, path }) => `${path}: ${message}`);
      clientFindings.push(
        ...violationsOf(CHAT_ORACLE.clientRequestsAccepted, [
          { invalidBody: errors },
        ]),
      );
      return {
        done: Promise.resolve(),
        response: new Response(JSON.stringify({ message: "Invalid body" }), {
          status: 422,
        }),
      };
    }
    const endRecord = beginRecord(raw);
    if (raw.forwardedProps.turnIntent === CHAT_TURN_INTENT.regenerate) {
      provider.promptLedgerOf(raw.threadId).replacesTail();
    }
    if (crashingThreads.delete(raw.threadId)) {
      try {
        const refused = await crashDuring(raw);
        await endRecord({
          ended: "complete",
          response: {
            body: await refused.clone().text(),
            status: refused.status,
            turnId: refused.headers.get(CHAT_TURN_ID_HEADER),
          },
        });
        return { done: Promise.resolve(), response: refused };
      } catch (error) {
        // The page reads no response: its request fails as a lost connection.
        await endRecord({
          ended: "connection-lost",
          response: { body: "", status: 0, turnId: null },
        });
        throw error;
      }
    }
    if (liveThreads.has(raw.threadId)) {
      const ctx = contextFromBody(raw, signal);
      const before = await readThreadMessages(raw.threadId);
      const result = await handle(ctx);
      if (result instanceof Response && result.ok) {
        return streamLive({
          before,
          ctx,
          endRecord,
          raw,
          response: result,
          signal,
        });
      }
      return {
        done: Promise.resolve(),
        response: await refuse(endRecord, result),
      };
    }
    const outcome = await sendAndCheck(contextFromBody(raw, signal));
    if (outcome.status === "rejected") {
      return {
        done: Promise.resolve(),
        response: await refuse(endRecord, outcome.rejection),
      };
    }
    clientFindings.push(...outcome.violations);
    delivered.set(raw.threadId, deliveredInterrupts(outcome.chunks));
    await endRecord({
      ended: "complete",
      response: {
        body: outcome.text,
        status: 200,
        turnId: outcome.headers.get(CHAT_TURN_ID_HEADER),
      },
    });
    return {
      done: Promise.resolve(),
      response: new Response(outcome.text, { headers: outcome.headers }),
    };
  };

  const originalFetch = globalThis.fetch;
  const routedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const resume =
      /^\/v1\/chat\/threads\/(?<threadId>[^/]+)\/turns\/(?<turnId>[^/]+)\/(?<delivery>resume|join)$/u.exec(
        url.pathname,
      )?.groups;
    if (
      resume?.["threadId"] !== undefined &&
      resume["turnId"] !== undefined &&
      (init?.method ?? "GET") === "GET"
    ) {
      const handler =
        resume["delivery"] === "join" ? joinChatTurn : probeChatTurn;
      const set = { headers: {}, status: 200 };
      const answer: unknown = await handler.handler(
        asTestRaw<Parameters<typeof handler.handler>[0]>({
          memberRole: sessionMemberRole("owner"),
          getWorkspaceAccess: async () => await Promise.resolve(null),
          params: {
            threadId: toSafeId<"chatThread">(resume["threadId"]),
            turnId: toSafeId<"chatTurn">(resume["turnId"]),
          },
          query: Object.fromEntries(url.searchParams),
          request: new Request(url.toString(), init),
          route: `/v1/chat/threads/:threadId/turns/:turnId/${resume["delivery"]}`,
          safeDb,
          scopedDb,
          session: { activeOrganizationId: ids.orgA },
          set,
          user: { id: userId },
        }),
      );
      if (answer instanceof Response) {
        return answer;
      }
      if (typeof answer === "object" && answer !== null && "type" in answer) {
        return Response.json(answer, { status: set.status });
      }
      return statusResponse(answer);
    }
    const cancel = CHAT_TURN_CANCEL_PATH.exec(url.pathname)?.groups;
    if (
      cancel?.["threadId"] !== undefined &&
      cancel["turnId"] !== undefined &&
      init?.method === "POST"
    ) {
      // Marked before the route answers: a run in this process ends its
      // response before the Stop's answer comes back. A refused Stop ends
      // nothing, so it takes the mark back.
      if (openConnections.has(cancel["threadId"])) {
        stoppingThreads.add(cancel["threadId"]);
      }
      inFlight += 1;
      try {
        const answer = await postCancelTurn({
          threadId: cancel["threadId"],
          turnId: cancel["turnId"],
        });
        if (!answer.ok) {
          stoppingThreads.delete(cancel["threadId"]);
        }
        return answer;
      } finally {
        inFlight -= 1;
      }
    }
    if (url.pathname !== CHAT_ROUTE_PATH || init?.method !== "POST") {
      return await originalFetch(input, init);
    }
    const raw = init.body;
    if (typeof raw !== "string") {
      return panic("The web chat client posted a non-JSON body");
    }
    inFlight += 1;
    let done: Promise<void> = Promise.resolve();
    try {
      const parsed: unknown = JSON.parse(raw);
      const posted = await postChatBody(parsed, init.signal ?? undefined);
      done = posted.done;
      return posted.response;
    } finally {
      void done.finally(() => {
        inFlight -= 1;
      });
    }
  };
  globalThis.fetch = Object.assign(routedFetch, {
    preconnect: originalFetch.preconnect,
  });

  /** A browser tab that loads `threadId` now, as a page load does. */
  const openWebClient = async (
    threadId: SafeId<"chatThread">,
    { context }: { context?: WebChatContext | undefined } = {},
  ): Promise<WebChatClient> =>
    await measure("clientSetup", async () => {
      provider.script(threadId);
      delivered.delete(threadId);
      return await createWebChatClient({
        context,
        profile,
        inFlight: () => inFlight,
        page: await reloadPage(threadId),
        reload: async () => await reloadPage(threadId),
        threadId,
      });
    });

  /**
   * Every oracle for a web client's page: each request it made since the last
   * check (wire, stored thread, refusals), the scripted model's queue, the
   * runtime's errors, and its live view against a reload.
   */
  const checkWebClient = async ({
    client,
    expected = {},
    threadId,
  }: {
    client: WebChatClient;
    /**
     * Signals the step is meant to produce. Each one must occur, and only
     * its own findings are waived: `runFailure` a runtime error report,
     * `refusal` the route refusing a request the page sent.
     */
    expected?: { refusal?: boolean; runFailure?: boolean };
    threadId: SafeId<"chatThread">;
  }): Promise<OracleViolation[]> =>
    await measure("oracle", async () => {
      const unsettled = await awaitSettledTurns(threadId);
      const [snapshot, reload] = await Promise.all([
        readSnapshot(threadId),
        reloadView(threadId),
      ]);
      const offered = offeredInteractionsOf(snapshot);
      const persisted = persistedViolationsOf(snapshot);
      const { changedToolResults, unconsumedScripts, unscriptedCalls } =
        provider.takeFindings(threadId);
      const requests = clientFindings.splice(0);
      const refusals = requests.filter(
        ({ oracle }) => oracle === CHAT_ORACLE.clientRequestsAccepted,
      );
      const errors = client.takeErrors().map((error) => Bun.inspect(error));
      const expectsError =
        expected.runFailure === true || expected.refusal === true;
      const web = await loadWebChat();
      const lastAnswer = (messages: readonly UIMessage[]) =>
        messages.findLast(({ role }) => role === "assistant") ?? null;
      const shown = findLiveOutcomeViolations({
        live: {
          error:
            client.runtimeState().hasError ||
            web.getChatAssistantTurnError(lastAnswer(client.messages())) !==
              undefined,
        },
        reload: {
          error:
            web.getChatAssistantTurnError(lastAnswer(reload)) !== undefined,
        },
      });
      return [
        ...(expected.refusal === true
          ? requests.filter((finding) => !refusals.includes(finding))
          : requests),
        ...(expected.refusal === true && refusals.length === 0
          ? violationsOf(CHAT_ORACLE.clientRequestsAccepted, [
              { expectedRefusal: "the route accepted every request" },
            ])
          : []),
        ...unsettled,
        ...persisted,
        ...violationsOf(CHAT_ORACLE.providerScriptsConsumed, [
          ...unconsumedScripts.map((script) => ({ unconsumed: script })),
          ...unscriptedCalls.map((call) => ({ unscripted: call })),
        ]),
        ...violationsOf(
          CHAT_ORACLE.providerPrefixStable,
          provider.promptLedgerOf(threadId).takeBreaks(),
        ),
        ...findTranscriptViolations(provider.takeRequests(threadId)),
        ...violationsOf(CHAT_ORACLE.providerResultsStable, changedToolResults),
        ...violationsOf(CHAT_ORACLE.clientNoErrors, [
          ...(expectsError ? [] : errors),
          ...(expectsError && errors.length === 0
            ? [{ expectedError: "the runtime reported none" }]
            : []),
        ]),
        ...findLiveViewViolations({
          delivered: delivered.get(threadId) ?? null,
          live: client.messages(),
          offered,
          reload,
        }),
        // A refused request's error is the request's, not a turn's.
        ...(expected.refusal === true ? [] : shown),
      ];
    });

  /** Fails on any violation `checkWebClient` finds. */
  const expectSoundWebClient = async (options: {
    client: WebChatClient;
    threadId: SafeId<"chatThread">;
  }): Promise<void> => {
    const violations = await checkWebClient(options);
    if (violations.length > 0) {
      panic(`The thread breaks an invariant: ${JSON.stringify(violations)}`);
    }
  };

  /**
   * Fails when any request of `threadId` so far resolved a stored ref to
   * another target than it named when stored (`chat.persisted.refs-stable`),
   * for callers that do not run every oracle through `checkWebClient`.
   */
  const expectStableRefs = (threadId: SafeId<"chatThread">): void => {
    const violations = refLedger.findingsOf(threadId);
    if (violations.length > 0) {
      panic(`The thread breaks an invariant: ${JSON.stringify(violations)}`);
    }
  };

  const lastAssistant = async (threadId: SafeId<"chatThread">) => {
    const message = (await readThreadMessages(threadId)).findLast(
      ({ role }) => role === "assistant",
    );
    if (message === undefined) {
      return panic("Expected an assistant message");
    }
    return message;
  };

  /**
   * An approval continuation built from stored parts rather than from a
   * page: for requests no browser showing the thread would send, such as
   * answering a card on a thread whose owning turn is gone. A user's
   * approval goes through `openWebClient` instead.
   */
  const approveContext = ({
    approved = true,
    call,
    interruptedRunId,
    messageId,
    parts,
    threadId,
  }: {
    /** Deny the call instead. */
    approved?: boolean | undefined;
    call: ApprovalCall;
    interruptedRunId: string;
    messageId: SafeId<"chatMessage">;
    parts: readonly ChatPart[];
    threadId: SafeId<"chatThread">;
  }): SendMessageCtx =>
    sendContext({
      message: {
        id: messageId,
        parts: parts.map((part) =>
          part.type === "tool-call" && part.id === call.id
            ? {
                ...call,
                approval: { ...call.approval, approved },
                state: "approval-responded",
              }
            : part,
        ),
        role: "assistant",
      },
      resume: {
        interruptedRunId,
        items: [
          {
            interruptId: call.approval.id,
            payload: { approved },
            status: "resolved",
          },
        ],
      },
      runId: `run-${Bun.randomUUIDv7()}`,
      threadId,
    });

  return {
    approveContext,
    checkWebClient,
    /**
     * Makes `threadId`'s next web request die mid-run: the process serving
     * it stops at the run's next stalling model call (script one), and the
     * turn's lease expires.
     */
    crashDuringNextRequest: (threadId: SafeId<"chatThread">) => {
      crashingThreads.add(threadId);
    },
    /** Runs the scheduler's reaper once, as its minute tick does. */
    reapOwnerlessTurns,
    /**
     * Ends what the test left running, then restores the model seam and
     * `fetch`; call once the test is done, before its database closes. A run
     * a simulated crash left stalled would otherwise keep beating on its
     * turn after that database is gone.
     */
    close: async () =>
      await measure("close", async () => {
        try {
          await relinquishChatTurnRuns();
          await Promise.all(abandonedReads);
        } finally {
          globalThis.fetch = originalFetch;
          provider.restore();
        }
        const rootPoolConnections = rootPoolConnectionCount();
        if (rootPoolConnections !== rootPoolConnectionsAtStart) {
          panic(
            "A chat turn connected to the shared database pools instead of the test database; inject that side path (as `indexThread` is) so it uses the test's database",
          );
        }
      }),
    /** Drops the connection of `threadId`'s response still streaming. */
    dropConnection: (threadId: SafeId<"chatThread">) => {
      (
        openConnections.get(threadId) ??
        panic("No response of this thread is streaming")
      )();
    },
    executions,
    expectSoundWebClient,
    expectStableRefs,
    lastAssistant,
    openWebClient,
    readPage,
    readThreadMessages,
    /** From now on, every request of `threadId` is recorded; the returned
     *  list fills as they settle. */
    recordThread: (threadId: SafeId<"chatThread">): RecordedExchange[] => {
      const recording: RecordedExchange[] = [];
      recordings.set(threadId, recording);
      return recording;
    },
    reloadView,
    /** From now on, `threadId`'s responses reach the page as the server
     *  writes them, so the page can stop one or lose its connection. */
    streamLive: (threadId: SafeId<"chatThread">) => {
      liveThreads.add(threadId);
    },
    /** From now on, `threadId`'s responses reach the page whole again. */
    streamWhole: (threadId: SafeId<"chatThread">) => {
      liveThreads.delete(threadId);
    },
    /**
     * Runs `race` once, when the next send has read its thread and is about
     * to accept its turn: what `race` does to the thread there (another
     * request, run to its end) lands between that send's read and its claim.
     */
    raceNextAcceptance: (race: () => Promise<void>) => {
      nextAcceptanceRace = race;
    },
    /** A compaction checkpoint landed on `threadId`: its next model call
     *  starts from the summary rather than extending the calls before it. */
    compacted: (threadId: SafeId<"chatThread">) => {
      provider.promptLedgerOf(threadId).compacted();
    },
    /** The provider options of `threadId`'s model calls so far. */
    modelOptionsOf: (threadId: SafeId<"chatThread">) =>
      provider.modelOptionsOf(threadId),
    /** The prompt of each of `threadId`'s model calls so far. */
    promptsOf: (threadId: SafeId<"chatThread">) => provider.promptsOf(threadId),
    /** Queues the model's runs for `threadId`'s next requests, one each. */
    script: (threadId: SafeId<"chatThread">, ...runs: ScriptedRun[]) => {
      provider.script(threadId, ...runs);
    },
    send,
    sendContext,
  };
};

/** The approval-gated call among `parts` still waiting for its answer. */
export const pendingApprovalCallOf = (
  parts: readonly ChatPart[],
): ApprovalCall => {
  const call = parts.find(
    (part): part is ApprovalCall =>
      part.type === "tool-call" &&
      part.name === APPROVAL_TOOL_NAME &&
      "approval" in part &&
      part.state === "approval-requested",
  );
  if (call === undefined) {
    return panic("Expected a pending approval-gated tool call");
  }
  return call;
};

export type ChatHarness = ReturnType<typeof createApprovalHarness>;
