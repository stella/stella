import { Value } from "@sinclair/typebox/value";
import { toolDefinition } from "@tanstack/ai";
import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatTurns } from "@/api/db/schema";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import { agUiSendMessageBodySchema } from "@/api/handlers/chat/chat-schema";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { loadChatMessagePage } from "@/api/handlers/chat/message-page";
import type { ChatMessagePage } from "@/api/handlers/chat/message-page";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import { streamChat } from "@/api/handlers/chat/stream-chat";
import { createStellaMcpToolSource } from "@/api/handlers/chat/tools/external-mcp-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatPart } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import {
  findLiveViewViolations,
  findUnstoredWireResults,
  findWireIdentityViolations,
} from "@/api/tests/helpers/chat-live-reload-invariants";
import type { DeliveredInterrupt } from "@/api/tests/helpers/chat-live-reload-invariants";
import { relayLiveResponse } from "@/api/tests/helpers/chat-live-response";
import {
  deliveredInterrupts,
  loadReloadView,
  readClientStreamChunks,
} from "@/api/tests/helpers/chat-live-view";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type {
  ChatOracleId,
  OracleViolation,
} from "@/api/tests/helpers/chat-oracles";
import { drainResponse } from "@/api/tests/helpers/chat-round-trip";
import { installScriptedProvider } from "@/api/tests/helpers/chat-scripted-provider";
import type { ScriptedRun } from "@/api/tests/helpers/chat-scripted-provider";
import {
  findOfferedInteractions,
  findThreadInvariantViolations,
} from "@/api/tests/helpers/chat-thread-invariants";
import { createWebChatClient } from "@/api/tests/helpers/chat-web-client";
import type { WebChatClient } from "@/api/tests/helpers/chat-web-client";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A real chat round trip: the production `send-message` handler and
// `streamChat` pipeline, with a scripted model behind the adapter seam, one
// counted approval-gated external tool, and the web app's own chat runtime as
// the browser. A web client (`openWebClient`) posts what its live view holds
// and answers only the cards that view shows. After every send the stored
// thread and the wire are checked, and `checkWebClient` compares what the
// page shows live with what a reload shows.

export const APPROVAL_TOOL_NAME = "mcp__external__delete";
/**
 * A built-in read tool that runs without asking: every external tool needs an
 * approval, so the plain server tool comes from Stella's own catalog.
 */
export const PLAIN_TOOL_NAME = "list_templates";
export const PLAIN_TOOL_ARGUMENTS = "{}";

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
  "lastActivityAt" | "olderCursor"
> & { messages: unknown[] };

/** One request a page sent on a recorded thread, as the route answered it. */
export type RecordedExchange = {
  /** Whether the page read the response to its end, the connection closed
   *  first (the page stopped, or the connection dropped), or no response
   *  came at all (the process serving it died). */
  ended: "complete" | "connection-lost" | "disconnected";
  /** The thread's first message page once the request had settled. */
  page: RecordedPage;
  /** The JSON body the page posted. */
  request: unknown;
  /** The SSE body the page read, or the route's refusal. */
  response: { body: string; status: number };
};

const CHAT_ROUTE_PATH = "/v1/chat";
const LIVE_TURN_STATUSES = ["accepted", "running"] as const;
const MAX_BARRIER_POLLS = 2000;
/** The checks a hand-built send answers for: the stored thread's. */
const STORED_THREAD_ORACLES: ReadonlySet<ChatOracleId> = new Set([
  CHAT_ORACLE.persistedCallsSettled,
  CHAT_ORACLE.persistedPendingOwned,
  CHAT_ORACLE.persistedTurnSettles,
]);

/** The page's connection dropping because the process serving it died. */
class ChatConnectionLostError extends TaggedError("ChatConnectionLostError")<{
  message: string;
}> {}

/** The HTTP answer the route gives a refused request, as the browser sees it. */
const refusalResponse = (rejection: unknown): Response => {
  const status: unknown =
    typeof rejection === "object" && rejection !== null
      ? Reflect.get(rejection, "code")
      : undefined;
  const body: unknown =
    typeof rejection === "object" && rejection !== null
      ? Reflect.get(rejection, "response")
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
  "modelOptionsOf" | "restore" | "script" | "stalled" | "takeFindings"
>;

export const createApprovalHarness = ({
  ids,
  model,
  organizationAIConfig = orgAIConfig,
  safeDb,
  scopedDb,
  testDb,
}: {
  ids: TestIds;
  /** Defaults to the scripted provider. */
  model?: HarnessModel | undefined;
  /** The organization's model selection; defaults to the harness's own. */
  organizationAIConfig?: OrgAIConfig | undefined;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  testDb: TestDatabase;
}) => {
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
  const sendMessage = createSendMessage({
    indexThread: async () => await Promise.resolve(undefined),
    loadExternalMcpTools: async () => {
      const close = async () => await Promise.resolve(undefined);
      return await Promise.resolve({
        close,
        connectors: [],
        source: createStellaMcpToolSource({
          closeClients: close,
          sourceTools: {},
        }),
        tools: { [APPROVAL_TOOL_NAME]: approvalTool },
      });
    },
    loadWebSearchProviders: async () =>
      await Promise.resolve({
        urlFetcher: null,
        webSearchProvider: null,
      }),
    rollbackSideEffects: rollbackUnpersistedChatSideEffects,
    streamResponse: streamChat,
    uploadMessageFiles: uploadMessageFilesWithRollback,
  });
  type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];
  type SendBody = SendMessageCtx["body"];
  const bodyByContext = new WeakMap<SendMessageCtx, SendBody>();

  /** The handler context the route builds around a validated body. */
  const contextFromBody = (
    body: SendBody,
    signal?: AbortSignal,
  ): SendMessageCtx => {
    const ctx = asTestRaw<SendMessageCtx>({
      body,
      createAuditRecorder: () => async () => await Promise.resolve(),
      getAccessibleWorkspaces: async () =>
        await Promise.resolve([
          { id: ids.wsA1, status: "active" },
          { id: ids.wsA2, status: "active" },
        ]),
      getActiveWorkspaceIds: async () =>
        await Promise.resolve([ids.wsA1, ids.wsA2]),
      getWorkspaceAccess: async () => await Promise.resolve(null),
      memberRole: { role: "owner" },
      orgAIConfig: organizationAIConfig,
      pinServerValidatedWorkspaceId: () => false,
      promptCachingEnabled: false,
      recordAuditEvent: async () => await Promise.resolve(),
      request: new Request("http://localhost/v1/chat/send", {
        ...(signal === undefined ? {} : { signal }),
      }),
      route: "/v1/chat/send",
      safeDb,
      scopedDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    });
    bodyByContext.set(ctx, body);
    return ctx;
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
  ): Promise<OracleViolation[]> => {
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
  };

  const reloadView = async (threadId: SafeId<"chatThread">) =>
    await loadReloadView({ safeDb, threadId, userId: ids.userA1 });

  const findPersistedViolations = async (
    threadId: SafeId<"chatThread">,
  ): Promise<OracleViolation[]> => {
    const { unownedPendingInteractions, unsettledToolCalls } =
      await findThreadInvariantViolations({ db: testDb, threadId });
    return [
      ...violationsOf(
        CHAT_ORACLE.persistedPendingOwned,
        unownedPendingInteractions,
      ),
      ...violationsOf(CHAT_ORACLE.persistedCallsSettled, unsettledToolCalls),
    ];
  };

  /**
   * Sends `ctx` and reads the response to its end, so its terminal
   * persistence runs; then checks the chunks the browser would read and,
   * past the turn barrier, the stored thread.
   */
  const sendAndCheck = async (ctx: SendMessageCtx) => {
    const body =
      bodyByContext.get(ctx) ??
      panic("Send contexts come from this harness's sendContext");
    const threadId = body.threadId;
    const result = await sendMessage.handler(ctx);
    if (!(result instanceof Response && result.ok)) {
      return { rejection: result, status: "rejected" } as const;
    }
    const text = await drainResponse(result);
    const chunks = await readClientStreamChunks({
      response: new Response(text, { headers: result.headers }),
      runId: body.runId,
      threadId,
    });
    const unsettled = await awaitSettledTurns(threadId);
    return {
      chunks,
      headers: result.headers,
      status: "streamed",
      text,
      violations: [
        ...unsettled,
        ...findWireIdentityViolations(chunks),
        ...findUnstoredWireResults({
          chunks,
          stored: await reloadView(threadId),
        }),
        ...(await findPersistedViolations(threadId)),
      ],
    } as const;
  };

  /**
   * A send from a hand-built context, the server's own request path: a
   * streamed response must leave the stored thread sound; any other handler
   * result is a rejection and is returned as-is for the assertion. The wire
   * and the page are a browser's concern, checked on the web-client path.
   */
  const send = async (
    ctx: SendMessageCtx,
  ): Promise<
    { status: "streamed" } | { rejection: unknown; status: "rejected" }
  > => {
    const outcome = await sendAndCheck(ctx);
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
  let inFlight = 0;

  /** Threads whose next web request is served by a process that then dies. */
  const crashingThreads = new Set<string>();

  /**
   * Serves `body` until the run reaches a stalling model call, then lets the
   * serving process die: nothing reads the rest of the response, the page's
   * connection drops, and the run never persists what it did after its last
   * write. The turn's lease is then expired, as a dead owner's would be.
   */
  const crashDuring = async (body: SendBody): Promise<Response> => {
    const threadId = body.threadId;
    const stalled = provider.stalled(threadId);
    // The dying process never sees the page go away, so no signal reaches it.
    const result = await sendMessage.handler(contextFromBody(body));
    if (!(result instanceof Response && result.ok)) {
      return refusalResponse(result);
    }
    // Reading the stream is what runs the turn; it stops at the stall.
    void drainResponse(result);
    await stalled;
    // The earliest lease the row allows: just after the turn was created.
    await testDb
      .update(chatTurns)
      .set({
        leaseExpiresAt: sql`${chatTurns.createdAt} + interval '1 millisecond'`,
      })
      .where(
        and(eq(chatTurns.threadId, threadId), eq(chatTurns.status, "running")),
      );
    throw new ChatConnectionLostError({ message: "Failed to fetch" });
  };

  const readPage = async (
    threadId: SafeId<"chatThread">,
  ): Promise<RecordedPage> => {
    const page = await loadChatMessagePage({
      safeDb,
      threadId,
      userId: ids.userA1,
    });
    if (Result.isError(page)) {
      return panic("The thread's message page failed to load", page.error);
    }
    // The page as the browser receives it: a JSON body.
    return asTestRaw<RecordedPage>(await Response.json(page.value).json());
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
    ended,
    endRecord,
    raw,
    text,
  }: {
    endRecord: RecordEnd;
    ended: RecordedExchange["ended"];
    raw: SendBody;
    text: string;
  }) => {
    const chunks = await readClientStreamChunks({
      response: new Response(text),
      runId: raw.runId,
      threadId: raw.threadId,
    });
    clientFindings.push(
      ...(await awaitSettledTurns(raw.threadId)),
      ...findWireIdentityViolations(chunks),
      ...findUnstoredWireResults({
        chunks,
        stored: await reloadView(raw.threadId),
      }),
      ...(await findPersistedViolations(raw.threadId)),
    );
    delivered.set(raw.threadId, deliveredInterrupts(chunks));
    await endRecord({ ended, response: { body: text, status: 200 } });
  };

  /**
   * A response handed to the page while the server is still writing it. It
   * ends when the server ends it, or when the page aborts its request or the
   * connection drops, which cancels the server's response the way a closed
   * socket does.
   */
  const streamLive = ({
    endRecord,
    raw,
    response,
    signal,
  }: {
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
      await afterResponse({ endRecord, ended: ending, raw, text });
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
    const response = refusalResponse(rejection);
    await endRecord({
      ended: "complete",
      response: {
        body: await response.clone().text(),
        status: response.status,
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
    if (crashingThreads.delete(raw.threadId)) {
      try {
        const refused = await crashDuring(raw);
        await endRecord({
          ended: "complete",
          response: {
            body: await refused.clone().text(),
            status: refused.status,
          },
        });
        return { done: Promise.resolve(), response: refused };
      } catch (error) {
        // The page reads no response: its request fails as a lost connection.
        await endRecord({
          ended: "connection-lost",
          response: { body: "", status: 0 },
        });
        throw error;
      }
    }
    if (liveThreads.has(raw.threadId)) {
      const result = await sendMessage.handler(contextFromBody(raw, signal));
      if (result instanceof Response && result.ok) {
        return streamLive({ endRecord, raw, response: result, signal });
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
      response: { body: outcome.text, status: 200 },
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
  ): Promise<WebChatClient> => {
    provider.script(threadId);
    delivered.delete(threadId);
    return await createWebChatClient({
      inFlight: () => inFlight,
      initialMessages: await reloadView(threadId),
      threadId,
    });
  };

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
  }): Promise<OracleViolation[]> => {
    const unsettled = await awaitSettledTurns(threadId);
    const [offered, reload, persisted] = await Promise.all([
      findOfferedInteractions({ db: testDb, threadId }),
      reloadView(threadId),
      findPersistedViolations(threadId),
    ]);
    const { unconsumedScripts, unscriptedCalls } =
      provider.takeFindings(threadId);
    const requests = clientFindings.splice(0);
    const refusals = requests.filter(
      ({ oracle }) => oracle === CHAT_ORACLE.clientRequestsAccepted,
    );
    const errors = client.takeErrors().map((error) => Bun.inspect(error));
    const expectsError =
      expected.runFailure === true || expected.refusal === true;
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
    ];
  };

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

  const readThreadMessages = async (threadId: SafeId<"chatThread">) =>
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
    ).map(chatMessageFromPersisted);

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
    call,
    interruptedRunId,
    messageId,
    parts,
    threadId,
  }: {
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
                approval: { ...call.approval, approved: true },
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
            payload: { approved: true },
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
    /** Restores the model seam and `fetch`; call once the test is done. */
    close: () => {
      globalThis.fetch = originalFetch;
      provider.restore();
    },
    /** Drops the connection of `threadId`'s response still streaming. */
    dropConnection: (threadId: SafeId<"chatThread">) => {
      (
        openConnections.get(threadId) ??
        panic("No response of this thread is streaming")
      )();
    },
    executions,
    expectSoundWebClient,
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
    /** The provider options of `threadId`'s model calls so far. */
    modelOptionsOf: (threadId: SafeId<"chatThread">) =>
      provider.modelOptionsOf(threadId),
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
