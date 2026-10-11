import type { ModelMessage } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import type {
  ChatClientState,
  ChatInterruptState,
  ConnectConnectionAdapter,
  MultimodalContent,
  RunAgentInputContext,
  UIMessage,
} from "@tanstack/ai-client";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { CHAT_SEND_MODE, isChatSendMode } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import {
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
  CHAT_TURN_ID_HEADER,
  CHAT_TURN_INTENT,
} from "@stll/api-contract";
import type { ChatSendRequest } from "@stll/api-contract";
import {
  ChatReconnectError,
  createDurableChatTransport,
} from "@stll/chat/durable-transport";
import {
  chatResumeSnapshotSchema,
  chatTurnResumeProbeSchema,
} from "@stll/chat/resume-contract";
import { sleep } from "@stll/concurrency/sleep";
import { fetchWithTimeout } from "@stll/fetch";

import type {
  ChatClientTools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import {
  getAwaitedAssistantMessageId,
  hasRunningToolCallInLatestAssistantMessage,
  isChatClientRequestActive,
} from "@/components/chat/chat-ui-tools";
import { createBrowserClientTool } from "@/features/chat/browser-control/browser-client-tool";
import { getBrowserClientCapability } from "@/features/chat/browser-control/browser-extension-bridge";
import { browserTurnId } from "@/features/chat/browser-control/browser-turn";
import { keepShownRejoinMessages } from "@/features/chat/chat-rejoin-messages";
import { keepPostedMessagesInSnapshots } from "@/features/chat/chat-snapshot-history";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import {
  CHAT_EDIT_APPLY_MODE,
  DOCX_EDIT_REPRESENTATION,
} from "@/lib/chat-edit-mode";
import type {
  ChatEditApplyMode,
  DocxEditRepresentation,
} from "@/lib/chat-edit-mode";
import { getChatThreadKey } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { actionAdmissionOutcome } from "@/lib/errors/action-admission";
import { APIError, chatRefusal, toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import { LifecycleRegistry } from "@/stores/lifecycle-registry";

import { chatFetchClient } from "./chat-fetch";
import { SUGGEST_TEMPLATE_FIELDS_TOOL_SCOPE } from "./chat-query-contract";
import type {
  ActiveFileContext,
  ChatThreadKey,
  ChatThreadOptionsContext,
} from "./chat-query-contract";

type ChatToolScope = typeof SUGGEST_TEMPLATE_FIELDS_TOOL_SCOPE;

export type ChatUserMessageInput = MultimodalContent & {
  id: SafeId<"chatMessage">;
};
export type ChatRouteHandoffMessage = ChatUserMessageInput;
export type ChatContinuationRequestBody = {
  docxEditRepresentation?: DocxEditRepresentation | undefined;
  editApplyMode?: ChatEditApplyMode | undefined;
  sendMode?: ChatSendMode | undefined;
  toolScope?: ChatToolScope | undefined;
  truncateAfterMessageId?: SafeId<"chatMessage"> | undefined;
  turnIntent?: (typeof CHAT_TURN_INTENT)["regenerate"] | undefined;
};
export type ChatSendMessageOptions = {
  body?: ChatContinuationRequestBody | undefined;
};
export type ChatRouteHandoffStart = {
  messageId: SafeId<"chatMessage">;
  status: "started";
  stream: Promise<void>;
};

/**
 * The composer's Stop, as the server hears it: nothing asked, a stop the
 * server has not answered yet, or one it refused (Stop stays available).
 */
export type ChatStopState =
  | { status: "idle" }
  | { status: "pending"; turnId: SafeId<"chatTurn"> }
  | { error: Error; status: "failed"; turnId: SafeId<"chatTurn"> };

type ChatRuntimeSnapshot = {
  error: Error | undefined;
  isLoading: boolean;
  reconnecting: boolean;
  messages: PersistedChatMessage[];
  sessionGenerating: boolean;
  status: ChatClientState;
  stop: ChatStopState;
  turnAbandoned: boolean;
};

type TanStackClientToolResult = Parameters<
  ChatClient<ChatClientTools>["addToolResult"]
>[0];

export type ChatToolResultInput = Omit<TanStackClientToolResult, "output"> & {
  output: unknown;
};

const CHAT_RUNTIME_BRAND: unique symbol = Symbol("StellaChatRuntime");

export type ChatRuntime = {
  readonly [CHAT_RUNTIME_BRAND]: true;
  resolveToolApproval: (
    response: {
      approved: boolean;
      id: string;
    },
    options?: ChatSendMessageOptions,
  ) => Promise<void>;
  addToolResult: (
    result: ChatToolResultInput,
    options?: ChatSendMessageOptions,
  ) => Promise<void>;
  getSnapshot: () => ChatRuntimeSnapshot;
  reload: (options?: ChatSendMessageOptions) => Promise<void>;
  setMessages: (messages: PersistedChatMessage[]) => void;
  startRouteHandoffMessage: (
    message: ChatRouteHandoffMessage,
    options?: ChatSendMessageOptions,
  ) => ChatRouteHandoffStart;
  /** The user's Stop: the server ends the turn as stopped. */
  stop: () => void;
  /** The page leaves the thread: it closes its own request and asks the
   *  server for nothing, so the turn carries on detached. */
  leave: () => void;
  subscribe: (listener: () => void) => () => void;
};

type ChatThreadSendMessage = (
  message: ChatUserMessageInput,
  options?: ChatSendMessageOptions,
) => Promise<void>;

const threadSendMessageByRuntime = new WeakMap<
  ChatRuntime,
  ChatThreadSendMessage
>();

export const sendThreadChatMessage = async (
  chat: ChatRuntime,
  message: ChatUserMessageInput,
  options?: ChatSendMessageOptions,
): Promise<void> => {
  const sendMessage = threadSendMessageByRuntime.get(chat);
  if (sendMessage === undefined) {
    panic("Missing thread send capability for chat runtime");
  }

  await sendMessage(message, options);
};

const getChatApiPath = () => apiUrl("/chat");

/** Runs `callback` once, later; the returned function cancels it. */
export type ChatEmitScheduler = (callback: () => void) => () => void;

// Twenty emits a second: the rate the render-storm canary
// (lib/render-storm-canary.ts) is calibrated against. One emit can commit
// twice (the page, then a store it syncs, such as a streamed draft in the
// inspector).
const STREAM_EMIT_INTERVAL_MS = 50;

// A timer, not an animation frame: a hidden tab pauses frames, and its
// transcript must still advance.
const scheduleStreamEmit: ChatEmitScheduler = (callback) => {
  const timeout = setTimeout(callback, STREAM_EMIT_INTERVAL_MS);
  return () => {
    clearTimeout(timeout);
  };
};

type CreateChatRuntimeProps = {
  /** The thread's turn not yet settled when the page loaded, which Stop
   *  cancels until a request names a newer one. */
  activeTurnId: SafeId<"chatTurn"> | null;
  context: ChatThreadOptionsContext | undefined;
  initialMessages: PersistedChatMessage[];
  key: ChatThreadKey;
  onError: (error: Error) => void;
  onFinish: () => void;
  /** Reload the thread from what the server stored: once a stop has settled,
   *  or once the page has left a turn that was still running. */
  reloadThread: () => void;
  /** When subscribers hear about messages that changed while a response
   *  streams. Defaults to `STREAM_EMIT_INTERVAL_MS` later. */
  scheduleEmit?: ChatEmitScheduler | undefined;
};

type ActiveToolResultOperation = {
  rejection: Error | undefined;
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const isRejectedChatContinuation = (error: unknown): boolean => {
  const visited = new Set<Error>();
  let current = error;

  while (current instanceof Error && !visited.has(current)) {
    if (
      APIError.is(current) &&
      current.code === CHAT_CONTINUATION_REJECTED_ERROR_CODE
    ) {
      return true;
    }
    visited.add(current);
    current = current.cause;
  }

  return false;
};

const CHAT_RESUME_PROBE_TIMEOUT_MS = 10_000;

/** How often, and how many times, a Stop the server accepted but has not
 *  settled yet (its run lives on another instance) asks again. */
const STOP_SETTLE_POLL_MS = 500;
const STOP_SETTLE_POLL_ATTEMPTS = 20;

/** Whether the stopped turn still runs (its owner settles it soon) or is
 *  settled. */
type StopAnswer = "running" | "settled";

/** Ask the server to stop `turnId`: its answer is the turn as it stands. */
const requestChatTurnStop = async ({
  threadId,
  turnId,
}: {
  threadId: string;
  turnId: SafeId<"chatTurn">;
}): Promise<Result<StopAnswer, Error>> => {
  const sent = await Result.tryPromise(
    async (): Promise<Result<StopAnswer, APIError>> => {
      const { data, error } = await api.chat
        .threads({ threadId: toSafeId<"chatThread">(threadId) })
        .turns({ turnId })
        .cancel.post();
      if (error) {
        return Result.err(toAPIError(error));
      }
      return Result.ok(data.turn.status === "running" ? "running" : "settled");
    },
  );
  return Result.isError(sent)
    ? Result.err(toError(sent.error.cause))
    : sent.value;
};

const ignoreAbandonedStreamError = (_error: unknown): void => undefined;

class ChatMessageStartError extends Error {
  readonly messageId: SafeId<"chatMessage">;

  constructor(messageId: SafeId<"chatMessage">) {
    super(
      `TanStack ChatClient did not append user message "${messageId}" before starting the stream.`,
    );
    this.name = "ChatMessageStartError";
    this.messageId = messageId;
  }
}

export const isChatMessageStartError = (
  error: unknown,
): error is ChatMessageStartError => error instanceof ChatMessageStartError;

const hasUserMessage = (
  messages: readonly PersistedChatMessage[],
  messageId: SafeId<"chatMessage">,
): boolean =>
  messages.some(
    (message) => message.role === "user" && message.id === messageId,
  );

export const createChatRuntime = ({
  activeTurnId,
  context,
  initialMessages,
  key,
  onError,
  onFinish,
  reloadThread,
  scheduleEmit = scheduleStreamEmit,
}: CreateChatRuntimeProps): ChatRuntime => {
  const listeners = new Set<() => void>();
  let subscriberCount = 0;
  let replayFloor = activeTurnId === null ? undefined : initialMessages;
  let activeToolResultOperation: ActiveToolResultOperation | undefined;
  let toolResultQueue = Promise.resolve();
  let snapshot: ChatRuntimeSnapshot = {
    error: undefined,
    isLoading: false,
    reconnecting: activeTurnId !== null,
    messages: initialMessages,
    sessionGenerating: false,
    status: "ready",
    stop: { status: "idle" },
    turnAbandoned: false,
  };
  /** The server turn the latest request runs; null from a new message until
   *  the server names its turn. */
  let turnId = activeTurnId;
  /** The turn the user last stopped. Its continuations never leave the page:
   *  the server settles it, and a result for it would only be refused. */
  let stoppedTurnId: SafeId<"chatTurn"> | null = null;
  let stopBeforeHeaders: "none" | "requested" = "none";
  const isStoppedTurn = (): boolean =>
    stoppedTurnId !== null && stoppedTurnId === turnId;
  /** A new message starts a new turn. Stop waits for its response headers
   *  to name the turn; a stop of the previous turn is over. */
  const startTurn = (): void => {
    turnId = null;
    stoppedTurnId = null;
    stopBeforeHeaders = "none";
    if (snapshot.stop.status !== "idle") {
      setSnapshot({ stop: { status: "idle" } });
    }
  };

  let cancelScheduledEmit: (() => void) | undefined;

  const emit = () => {
    cancelScheduledEmit?.();
    cancelScheduledEmit = undefined;
    for (const listener of listeners) {
      listener();
    }
  };

  // A streamed response changes `messages` once per chunk, hundreds of times
  // a second for a large tool input. `snapshot` always holds the latest, so
  // imperative readers never lag; subscribers hear about it once per
  // `scheduleEmit` interval. Every other change emits at once and carries the
  // latest messages with it, so no subscriber sees a status, error or stop
  // ahead of the messages it describes, and a run's last messages arrive with
  // its end.
  const emitMessagesChange = () => {
    if (!snapshot.isLoading && !snapshot.sessionGenerating) {
      emit();
      return;
    }
    cancelScheduledEmit ??= scheduleEmit(() => {
      cancelScheduledEmit = undefined;
      emit();
    });
  };

  const setSnapshot = (patch: Partial<ChatRuntimeSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    emit();
  };

  const captureRuntimeError = (error: unknown): Error => {
    const normalized = toError(error);
    if (snapshot.error !== normalized) {
      onError(normalized);
      setSnapshot({ error: normalized });
    }
    return normalized;
  };

  const enqueueToolResult = async (
    operation: () => Promise<void>,
  ): Promise<void> => {
    const queued = toolResultQueue.then(operation);
    toolResultQueue = queued.catch(ignoreAbandonedStreamError);
    await queued;
  };

  type PendingInterruptResolution = {
    apply: () => void;
    reject: (error: Error) => void;
    resolve: () => void;
  };
  type InterruptSubmissionWaiter = {
    resolutions: PendingInterruptResolution[];
    sawResuming: boolean;
  };
  let interruptSubmissionWaiter: InterruptSubmissionWaiter | undefined;
  let interruptResolutionFlushScheduled = false;
  const pendingInterruptResolutions: PendingInterruptResolution[] = [];
  const observeInterruptSubmission = (
    state: ChatInterruptState<ChatClientTools>,
  ): void => {
    const waiter = interruptSubmissionWaiter;
    if (waiter === undefined) {
      return;
    }
    if (state.resuming) {
      waiter.sawResuming = true;
      return;
    }
    const errors = [
      ...state.interruptErrors,
      ...state.interrupts.flatMap((interrupt) => interrupt.errors),
    ];
    const firstError = errors.at(0);
    if (firstError !== undefined) {
      interruptSubmissionWaiter = undefined;
      const error = new ClientOperationError({
        action: `submit-chat-interrupt:${firstError.code}`,
        cause: firstError,
        message: firstError.message,
      });
      for (const resolution of waiter.resolutions) {
        resolution.reject(error);
      }
      return;
    }
    // Answers conclude once their submission ran, or once nothing is left to
    // submit: the interrupts were withdrawn before the batch was complete, by
    // a message that superseded them (`supersedePendingInterrupts`) or by the
    // run ending elsewhere. TanStack publishes that as an empty, idle state
    // with no error, and the server settles the call either way.
    if (waiter.sawResuming || state.interrupts.length === 0) {
      interruptSubmissionWaiter = undefined;
      for (const resolution of waiter.resolutions) {
        resolution.resolve();
      }
    }
  };

  const turnObservingFetchClient = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await chatFetchClient(input, init);
      const servedTurnId = response.headers.get(CHAT_TURN_ID_HEADER);
      if (servedTurnId !== null) {
        turnId = toSafeId<"chatTurn">(servedTurnId);
        if (stopBeforeHeaders === "requested") {
          stopBeforeHeaders = "none";
          stoppedTurnId = turnId;
          setSnapshot({
            stop: { status: "pending", turnId },
            turnAbandoned: true,
          });
          detached(settleStop(turnId), "chat-runtime.stop-before-headers");
        }
      }
      return response;
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch;
  const turnUrl = (action: "resume" | "join") => {
    if (turnId === null) {
      return panic("Cannot rejoin a chat before the server names its turn");
    }
    const url = new URL(
      apiUrl(`/chat/threads/${key.threadId}/turns/${turnId}/${action}`),
    );
    if (key.scope === "workspace") {
      url.searchParams.set("workspaceId", key.workspaceId);
    }
    return url.toString();
  };
  const loadedResume = v.safeParse(
    chatResumeSnapshotSchema,
    initialMessages.at(-1)?.metadata?.resumeSnapshot,
  );
  const { connection: upstreamConnection, persistence } =
    createDurableChatTransport({
      initialMessages,
      initialTurn:
        loadedResume.success &&
        (loadedResume.output.pendingInterrupts?.length ?? 0) > 0
          ? { type: "parked", runId: loadedResume.output.resumeState.runId }
          : {
              // A turn parked by a release without native resume state is
              // already whole on the loaded page; reloading cannot change it.
              type:
                activeTurnId === null ||
                getAwaitedAssistantMessageId(initialMessages) !== null
                  ? "settled"
                  : "active",
            },
      threadId: key.threadId,
      sendUrl: getChatApiPath(),
      joinUrl: () => turnUrl("join"),
      fetchClient: turnObservingFetchClient,
      onReconnectChange: (reconnecting) => {
        setSnapshot({ reconnecting });
      },
      onError: (error) => {
        captureRuntimeError(error);
      },
      onTranscript: () => {
        setSnapshot({ turnAbandoned: true });
        reloadThread();
      },
      // The SDK adapter consumes Promise rejections; shared transport catches
      // typed probe failures with Result and surfaces them through onError.
      probe: async (signal) => {
        if (turnId === null) {
          const resume: unknown =
            initialMessages.at(-1)?.metadata?.resumeSnapshot;
          if (resume === undefined) {
            return { type: "transcript", turnId: "" };
          }
          const parsed = v.safeParse(chatResumeSnapshotSchema, resume);
          if (!parsed.success) {
            return await Promise.reject(
              new ChatReconnectError({
                code: "invalid-response",
                message: "Invalid chat resume state.",
              }),
            );
          }
          return {
            type: "transcript",
            turnId: "",
            resumeSnapshot: parsed.output,
          };
        }
        const response = await fetchWithTimeout(turnUrl("resume"), {
          credentials: "include",
          ...(signal === undefined || signal === null ? {} : { signal }),
          timeout: { type: "idle", ms: CHAT_RESUME_PROBE_TIMEOUT_MS },
        });
        if (!response.ok) {
          if (response.status === 404) {
            return { type: "transcript", turnId };
          }
          return await Promise.reject(
            new ChatReconnectError({
              ...(response.status === 401 || response.status === 403
                ? { code: "refused" as const }
                : {}),
              message: `Chat resume probe failed (${response.status}).`,
            }),
          );
        }
        const data: unknown = await response.json();
        const parsed = v.safeParse(chatTurnResumeProbeSchema, data);
        if (!parsed.success) {
          return await Promise.reject(
            new ChatReconnectError({
              code: "invalid-response",
              message: "Invalid chat resume state.",
            }),
          );
        }
        return parsed.output;
      },
    });
  const connection = {
    joinRun: (runId, signal) =>
      keepPostedMessagesInSnapshots(
        snapshot.messages,
        upstreamConnection.joinRun(runId, signal),
      ),
    connect: (messages, data, abortSignal, runContext) => {
      if (runContext === undefined) {
        return panic("TanStack connection omitted the AG-UI run context");
      }
      if (!messages.every(isChatUiMessage)) {
        return panic("Stella chat connection received model messages");
      }
      return keepPostedMessagesInSnapshots(
        messages,
        upstreamConnection.connect(
          messages,
          buildSendRequestBody({
            context,
            key,
            messages: toPersistedChatMessages(messages),
            run: runContext,
            requestBody: normalizeChatContinuationRequestBody(data),
          }),
          abortSignal,
          runContext,
        ),
      );
    },
  } satisfies ConnectConnectionAdapter;

  // The extension budgets browser commands per chat turn, named by its
  // persisted user message, so a runtime rebuilt mid-turn charges the same
  // turn.
  const browserTool = createBrowserClientTool({
    turnIdFor: (toolCallId) => browserTurnId(snapshot.messages, toolCallId),
  });

  // The SDK rejoins a persisted in-flight run only while a view tails it, and
  // drops a resume that lands earlier. Read server truth once one is attached.
  const viewerAttached = Promise.withResolvers<undefined>();
  const attachedPersistence = {
    ...persistence,
    getItem: async (threadId: string) => {
      await viewerAttached.promise;
      return await persistence.getItem(threadId);
    },
  } satisfies typeof persistence;

  const client = new ChatClient<ChatClientTools, unknown, readonly []>({
    threadId: key.threadId,
    initialMessages,
    persistence: attachedPersistence,
    connection,
    onError: (error) => {
      // A request of a turn the user stopped fails as the stop's own effect
      // (a result the server no longer owns, a request closed): the server
      // decides how the turn ends, and the page reloads that.
      if (isStoppedTurn()) {
        return;
      }
      if (
        activeToolResultOperation !== undefined &&
        isRejectedChatContinuation(error)
      ) {
        activeToolResultOperation.rejection = error;
      }
      onError(error);
      setSnapshot({ error });
    },
    onErrorChange: (error) => {
      // The SDK can replay a transport failure as a generic RUN_ERROR after
      // reporting its typed cause. A new request clears the error first.
      if (
        error !== undefined &&
        ((actionAdmissionOutcome(snapshot.error) &&
          !actionAdmissionOutcome(error)) ||
          (chatRefusal(snapshot.error) !== null && chatRefusal(error) === null))
      ) {
        return;
      }
      if (error === undefined || !isStoppedTurn()) {
        setSnapshot({ error });
      }
    },
    onFinish: () => {
      replayFloor = undefined;
      onFinish();
    },
    onInterruptStateChange: observeInterruptSubmission,
    onLoadingChange: (isLoading) => {
      setSnapshot({
        isLoading,
        ...(!isLoading ? { reconnecting: false } : {}),
        ...(isLoading && stopBeforeHeaders === "none" && !isStoppedTurn()
          ? { turnAbandoned: false }
          : {}),
      });
    },
    onMessagesChange: (messages) => {
      const persisted = toPersistedChatMessages(messages);
      snapshot = {
        ...snapshot,
        messages:
          replayFloor === undefined
            ? persisted
            : keepShownRejoinMessages(replayFloor, persisted),
      };
      emitMessagesChange();
    },
    onSessionGeneratingChange: (sessionGenerating) =>
      setSnapshot({ sessionGenerating }),
    onStatusChange: (status) => setSnapshot({ status }),
    tools: [browserTool.tool],
  });

  /**
   * Wait for the page's request to end before answering a card or an
   * approval. The server sends a run's RUN_FINISHED, which carries the
   * interrupt an answer resolves, only once it has stored the turn, so the
   * card can be answered before the page knows that interrupt. TanStack
   * applies such an answer to the message, finds nothing to resolve, and then
   * hydrates the interrupt as pending: the card reads answered and the turn
   * never continues. Once the request has ended the interrupt is known.
   * Resolves false when the user stopped the turn meanwhile: its answers
   * never leave the page. A request closed by `client.stop()` needs no check
   * here; TanStack drops an answer to the stream it stopped.
   */
  const awaitRequestEnd = async (): Promise<boolean> => {
    if (!snapshot.isLoading) {
      return true;
    }
    await new Promise<void>((resolve) => {
      const listener = () => {
        if (!snapshot.isLoading) {
          listeners.delete(listener);
          resolve();
        }
      };
      listeners.add(listener);
    });
    return !isStoppedTurn();
  };

  const withBody = async (
    options: ChatSendMessageOptions | undefined,
    action: () => Promise<void>,
  ) => {
    if (options?.body !== undefined) {
      client.updateOptions({ forwardedProps: options.body });
    }

    try {
      await action();
    } finally {
      if (options?.body !== undefined) {
        client.updateOptions({ forwardedProps: {} });
      }
    }
  };

  const flushInterruptResolutions = (): void => {
    interruptResolutionFlushScheduled = false;
    const resolutions = pendingInterruptResolutions.splice(0);
    if (resolutions.length === 0) {
      return;
    }
    let waiter = interruptSubmissionWaiter;
    if (waiter?.sawResuming) {
      const error = new ClientOperationError({
        action: "submit-chat-interrupt:already-active",
        message: "Native interrupt submission is already active",
      });
      for (const resolution of resolutions) {
        resolution.reject(error);
      }
      return;
    }

    if (waiter === undefined) {
      waiter = {
        resolutions: [],
        sawResuming: false,
      };
      interruptSubmissionWaiter = waiter;
    }
    waiter.resolutions.push(...resolutions);
    try {
      for (const resolution of resolutions) {
        resolution.apply();
        if (interruptSubmissionWaiter !== waiter) {
          return;
        }
      }
      observeInterruptSubmission(client.getInterruptState());
    } catch (error) {
      if (interruptSubmissionWaiter === waiter) {
        interruptSubmissionWaiter = undefined;
      }
      const normalized = toError(error);
      for (const resolution of waiter.resolutions) {
        resolution.reject(normalized);
      }
    }
  };

  const resolveNativeInterrupt = async (
    resolveInterrupt: () => void,
  ): Promise<void> =>
    await new Promise((resolve, reject) => {
      pendingInterruptResolutions.push({
        apply: resolveInterrupt,
        reject,
        resolve,
      });
      if (!interruptResolutionFlushScheduled) {
        interruptResolutionFlushScheduled = true;
        queueMicrotask(flushInterruptResolutions);
      }
    });

  // TanStack refuses a normal send while its interrupt manager still owns the
  // turn ("cannot send normal input while pending interrupts exist"). The
  // server has the reverse contract: a new message supersedes the awaited
  // interaction, and accepting the turn cancels it
  // (`insertChatTurnAcceptanceOnTx`). Drop the local interrupt state first so
  // a user who ignores an approval or a card can keep typing. `stop()` is the
  // only public reset of that state; with no request in flight its other
  // effects are no-ops. A request in flight is a resume being submitted, so
  // leave it alone: TanStack refuses the send, `ChatMessageStartError` keeps
  // its "busy, retry" meaning, and the send queue retries after the turn.
  // A send that fails after the reset is the turn's error like any other:
  // `onError` refreshes the thread from the server, whose transcript still
  // ends on the awaited call if the message was never accepted, and the
  // rebuilt runtime answers it through the reload path in
  // `answerToolApproval`.
  const supersedePendingInterrupts = (): void => {
    if (client.getResumeState() === null) {
      return;
    }
    if (snapshot.isLoading || isChatClientRequestActive(snapshot.status)) {
      return;
    }
    client.stop();
  };

  /** Tails the client first, so a persisted resume read after it rejoins. */
  const attachClient = () => {
    client.attach();
    viewerAttached.resolve(undefined);
  };

  const startClientSend = (
    message: ChatUserMessageInput,
    options: ChatSendMessageOptions | undefined,
  ): ChatRouteHandoffStart => {
    attachClient();
    supersedePendingInterrupts();
    const stream = client.sendMessage(message, options?.body);
    if (!hasUserMessage(snapshot.messages, message.id)) {
      detached(stream.catch(ignoreAbandonedStreamError), "chat-queries.stream");
      throw captureRuntimeError(new ChatMessageStartError(message.id));
    }
    startTurn();
    return { messageId: message.id, status: "started", stream };
  };

  const sendThreadMessage: ChatThreadSendMessage = async (message, options) => {
    const { stream } = startClientSend(message, options);
    try {
      await stream;
    } catch (error) {
      throw captureRuntimeError(error);
    }
  };

  /**
   * Each approval's answer, by approval id. An approval is answered once: a
   * second answer to it (a click racing its card's automatic answer) joins
   * the first instead of resolving the interrupt again. A failed answer is
   * not kept, so it does not stand in for a later answer to the same id.
   */
  const approvalAnswers = new Map<string, Promise<void>>();

  const answerToolApproval = async (
    response: { approved: boolean; id: string },
    options: ChatSendMessageOptions | undefined,
  ) => {
    if (!(await awaitRequestEnd())) {
      return;
    }
    await withBody(options, async () => {
      const interrupt = client
        .getInterrupts()
        .find(
          (candidate) =>
            candidate.kind === "generic" &&
            (candidate.interruptId === response.id ||
              candidate.id === response.id),
        );
      if (interrupt?.kind === "generic") {
        // Stella's server tool catalog is dynamic, so the browser has no
        // runtime tool definitions with which to specialize the binding.
        // TanStack therefore exposes the native descriptor as a generic
        // bound interrupt; its response schema is the strict authority.
        await resolveNativeInterrupt(() => {
          interrupt.resolveInterrupt({ approved: response.approved });
        });
        return;
      }

      // Transitional reload path for turns persisted before native AG-UI
      // interrupt descriptors were available. New live turns always resolve
      // through the bound interrupt above.
      await client.addToolApprovalResponse(response);
    });
  };

  /**
   * The server's answer to a Stop of `stoppedTurn`. Until the turn settles the
   * page keeps its request open: the server ends a run it can reach, and the
   * request then closes by itself. An answer about a turn the page has since
   * left is ignored, so it never stops or reloads a newer turn.
   */
  const settleStop = async (stoppedTurn: SafeId<"chatTurn">) => {
    let answer = await requestChatTurnStop({
      threadId: key.threadId,
      turnId: stoppedTurn,
    });
    const isCurrent = () =>
      turnId === stoppedTurn &&
      snapshot.stop.status === "pending" &&
      snapshot.stop.turnId === stoppedTurn;
    if (!isCurrent()) {
      return;
    }
    if (Result.isError(answer)) {
      stoppedTurnId = null;
      setSnapshot({
        stop: { error: answer.error, status: "failed", turnId: stoppedTurn },
        turnAbandoned: false,
      });
      return;
    }
    // The server holds the stop, so closing the request can no longer turn it
    // into a dropped connection. A run on another instance settles once it
    // sees the stop; the page reloads after that.
    client.stop();
    for (
      let attempt = 0;
      Result.isOk(answer) &&
      answer.value === "running" &&
      attempt < STOP_SETTLE_POLL_ATTEMPTS;
      attempt += 1
    ) {
      await sleep(STOP_SETTLE_POLL_MS);
      answer = await requestChatTurnStop({
        threadId: key.threadId,
        turnId: stoppedTurn,
      });
    }
    if (!isCurrent()) {
      return;
    }
    // A failed poll is not a settled turn. The server already holds the stop,
    // so Stop stays available to ask again.
    if (Result.isError(answer)) {
      stoppedTurnId = null;
      setSnapshot({
        stop: { error: answer.error, status: "failed", turnId: stoppedTurn },
        turnAbandoned: false,
      });
      return;
    }
    // Settled, or still running once the polls run out (its owner is gone
    // and its lease has yet to lapse): reload what the server stores. The
    // stopped turn's continuations stay held back either way.
    setSnapshot({ stop: { status: "idle" } });
    reloadThread();
  };

  const isTurnActive = (): boolean =>
    snapshot.isLoading ||
    snapshot.reconnecting ||
    snapshot.sessionGenerating ||
    isChatClientRequestActive(snapshot.status) ||
    hasRunningToolCallInLatestAssistantMessage({
      messages: snapshot.messages,
    });

  /** Detach delivery and refresh the thread; its server turn keeps running. */
  const closeRequest = (): void => {
    const turnWasActive = isTurnActive();
    client.detach();
    if (turnWasActive) {
      setSnapshot({ turnAbandoned: true });
      reloadThread();
    }
  };

  const runtime = {
    [CHAT_RUNTIME_BRAND]: true,
    resolveToolApproval: async (response, options) => {
      if (isStoppedTurn()) {
        return;
      }
      const pending = approvalAnswers.get(response.id);
      if (pending !== undefined) {
        await pending;
        return;
      }
      const answer = Result.tryPromise(
        async () => await answerToolApproval(response, options),
      );
      approvalAnswers.set(
        response.id,
        answer.then(() => undefined),
      );
      const outcome = await answer;
      if (Result.isError(outcome)) {
        approvalAnswers.delete(response.id);
        // The failed continuation is the turn's error, shown like any other.
        // Its card stays answered; the thread reloads from the server, and
        // the next message settles the turn.
        captureRuntimeError(outcome.error.cause);
      }
    },
    addToolResult: async (result, options) => {
      if (isStoppedTurn()) {
        return;
      }
      await enqueueToolResult(async () => {
        if (!(await awaitRequestEnd())) {
          return;
        }
        const messagesBeforeResult = snapshot.messages;
        const errorBeforeResult = snapshot.error;
        const operation: ActiveToolResultOperation = { rejection: undefined };
        activeToolResultOperation = operation;
        try {
          await withBody(options, async () => {
            try {
              await client.addToolResult({
                tool: result.tool,
                toolCallId: result.toolCallId,
                output: result.output,
                ...(result.state === undefined ? {} : { state: result.state }),
                ...(result.errorText === undefined
                  ? {}
                  : { errorText: result.errorText }),
              });
              if (
                snapshot.error !== undefined &&
                snapshot.error !== errorBeforeResult
              ) {
                throw snapshot.error;
              }
            } catch (error) {
              if (
                operation.rejection !== undefined ||
                isRejectedChatContinuation(error)
              ) {
                // TanStack applies the result optimistically before it sends
                // the continuation. A rejected request must not leave that
                // local result looking durable: generated-document saving
                // uses the completed server message as its authorization
                // proof. A failure after a successful HTTP response is
                // different: the server has already persisted the result, so
                // the optimistic state is true.
                client.setMessagesManually(messagesBeforeResult);
                setSnapshot({ messages: messagesBeforeResult });
              }
              throw error;
            }
          });
        } finally {
          if (activeToolResultOperation === operation) {
            activeToolResultOperation = undefined;
          }
        }
      });
    },
    getSnapshot: () => snapshot,
    reload: async (options) => {
      startTurn();
      browserTool.resume();
      await withBody(
        {
          body: {
            ...options?.body,
            turnIntent: CHAT_TURN_INTENT.regenerate,
          },
        },
        async () => {
          await client.reload();
        },
      );
    },
    setMessages: (messages) => {
      client.setMessagesManually(messages);
      setSnapshot({ messages });
    },
    startRouteHandoffMessage: (message, options) => {
      const started = startClientSend(message, options);
      detached(
        started.stream.catch(captureRuntimeError),
        "chat-queries.stream",
      );
      return started;
    },
    stop: () => {
      // Stopping the request does not stop the extension: a browser command
      // already approved would otherwise keep acting on the page.
      browserTool.cancel();
      const stoppedTurn = turnId;
      if (stoppedTurn === null && isTurnActive()) {
        // Delivery cancellation no longer ends the accepted server turn.
        // Keep this request until its headers name the turn to cancel.
        stopBeforeHeaders = "requested";
        setSnapshot({ turnAbandoned: true });
        return;
      }
      if (!isTurnActive() || stoppedTurn === null) {
        closeRequest();
        return;
      }
      // Shown stopped at once. The server decides how the turn ends, and the
      // thread is reloaded from it once it has: a local rewrite of the
      // stopped parts would differ from what a reload shows.
      setSnapshot({ turnAbandoned: true });
      if (
        snapshot.stop.status === "pending" &&
        snapshot.stop.turnId === stoppedTurn
      ) {
        return;
      }
      stoppedTurnId = stoppedTurn;
      setSnapshot({ stop: { status: "pending", turnId: stoppedTurn } });
      detached(settleStop(stoppedTurn), "chat-runtime.stop");
    },
    leave: closeRequest,
    subscribe: (listener) => {
      listeners.add(listener);
      subscriberCount += 1;
      attachClient();
      return () => {
        listeners.delete(listener);
        subscriberCount -= 1;
        if (subscriberCount === 0) {
          client.detach();
        }
      };
    },
  } satisfies ChatRuntime;

  threadSendMessageByRuntime.set(runtime, sendThreadMessage);

  return runtime;
};

const toPersistedChatMessages = (
  messages: readonly UIMessage<ChatClientTools>[],
): PersistedChatMessage[] =>
  messages.map((message) => {
    if (
      message.role !== "assistant" ||
      !message.parts.some(
        (part) => part.type === "text" && part.content.trim().length === 0,
      )
    ) {
      return message;
    }
    // RUN_ERROR can leave whitespace parts that server finalization drops.
    return {
      ...message,
      parts: message.parts.filter(
        (part) => part.type !== "text" || part.content.trim().length > 0,
      ),
    };
  });

const isChatUiMessage = (
  message: ModelMessage | UIMessage,
): message is UIMessage<ChatClientTools> =>
  "parts" in message && Array.isArray(message.parts);

const toChatSendDocxEditSnapshot = (
  snapshot: NonNullable<ActiveFileContext["docxEditSnapshot"]>,
): NonNullable<
  NonNullable<ChatSendRequest["activeFile"]>["docxEditSnapshot"]
> => ({
  blocks: snapshot.blocks.map((block) => ({
    id: block.id,
    kind: block.kind,
    text: block.text,
    ...(block.displayLabel === undefined
      ? {}
      : { displayLabel: block.displayLabel }),
    ...(block.styleId === undefined ? {} : { styleId: block.styleId }),
  })),
  ...(snapshot.canApplyEdits === undefined
    ? {}
    : { canApplyEdits: snapshot.canApplyEdits }),
});

type ChatSendRequestDraft = Omit<
  ChatSendRequest,
  "message" | "parentRunId" | "resume"
> & {
  message: ChatSendRequest["message"];
};

export const buildSendRequestBody = ({
  context,
  key,
  messages,
  run,
  requestBody,
}: {
  context: ChatThreadOptionsContext | undefined;
  key: ChatThreadKey;
  messages: PersistedChatMessage[];
  run: Pick<
    RunAgentInputContext,
    "parentRunId" | "resume" | "runId" | "threadId"
  >;
  requestBody?: ChatContinuationRequestBody | undefined;
}): ChatSendRequest => {
  const message = messages.at(-1);
  if (!message) {
    panic("Missing chat message");
  }

  const body: ChatSendRequestDraft = {
    message: {
      ...message,
      id: toSafeId<"chatMessage">(message.id),
    },
    sendMode: resolveChatRequestSendMode({
      context,
      key,
      messages,
      requestBody,
    }),
    runId: run.runId,
    threadId: key.threadId,
  };

  const browserClient = getBrowserClientCapability();
  if (browserClient) {
    body.browserClient = browserClient;
  }

  if (requestBody?.truncateAfterMessageId !== undefined) {
    body.truncateAfterMessageId = requestBody.truncateAfterMessageId;
  }

  if (requestBody?.turnIntent !== undefined) {
    body.turnIntent = requestBody.turnIntent;
  }

  if (requestBody?.toolScope !== undefined) {
    body.toolScope = requestBody.toolScope;
  }

  if (key.scope === "workspace") {
    body.workspaceId = toSafeId<"workspace">(key.workspaceId);
  }

  const userContext = context?.getUserContext?.();
  if (userContext) {
    body.userContext = userContext;
  }

  applyChatContext({ body, context });

  const { editApplyMode, docxEditRepresentation } =
    resolveChatRequestDocxEditPreferences({
      context,
      key,
      messages,
      requestBody,
    });
  if (editApplyMode !== undefined) {
    body.editApplyMode = editApplyMode;
  }

  if (docxEditRepresentation !== undefined) {
    body.docxEditRepresentation = docxEditRepresentation;
  }

  if (
    message.role === "user" &&
    (editApplyMode !== undefined || docxEditRepresentation !== undefined)
  ) {
    body.message.metadata = {
      ...message.metadata,
      docxEditPreferences: {
        ...(editApplyMode === undefined ? {} : { editApplyMode }),
        ...(docxEditRepresentation === undefined
          ? {}
          : { docxEditRepresentation }),
      },
    };
  }

  if (run.resume === undefined) {
    if (run.parentRunId !== undefined) {
      panic("Chat continuation parent is missing native resume data");
    }
    return body;
  }
  const continuationMessage = body.message;
  if (
    run.parentRunId === undefined ||
    continuationMessage.role !== "assistant"
  ) {
    panic("Native chat resume must continue an assistant message");
  }
  return {
    ...body,
    message: { ...continuationMessage, role: "assistant" },
    parentRunId: run.parentRunId,
    resume: run.resume.map((resolution) => {
      if (resolution.status === "cancelled") {
        return {
          interruptId: resolution.interruptId,
          status: resolution.status,
        };
      }
      const payload: unknown = resolution.payload;
      return {
        interruptId: resolution.interruptId,
        ...(payload === undefined ? {} : { payload }),
        status: resolution.status,
      };
    }),
  };
};

/**
 * Every active-document getter, paired with the send-body field that carries
 * its value.
 *
 * Total over the context's `getActive*` capabilities, so a new active document
 * cannot be declared without choosing a field here, and the send test drives
 * this map instead of a hand-written list: a getter whose value never reaches
 * the body fails there rather than going out silently omitted.
 */
export const ACTIVE_DOCUMENT_SEND_FIELD = {
  getActiveDecision: "activeDecision",
  getActiveDraft: "activeDraft",
  getActiveExternal: "activeExternal",
  getActiveFile: "activeFile",
  getActiveSkill: "activeSkill",
  getActiveStatute: "activeStatute",
  getActiveTemplate: "activeTemplate",
} as const satisfies Record<
  Extract<keyof ChatThreadOptionsContext, `getActive${string}`>,
  keyof ChatSendRequestDraft
>;

const applyChatContext = ({
  body,
  context,
}: {
  body: ChatSendRequestDraft;
  context: ChatThreadOptionsContext | undefined;
}) => {
  const activeFile = context?.getActiveFile?.();
  if (activeFile) {
    body.activeFile = {
      entityId: toSafeId<"entity">(activeFile.entityId),
      fileName: activeFile.fileName,
      ...(activeFile.fileFieldId === undefined
        ? {}
        : { fileFieldId: toSafeId<"field">(activeFile.fileFieldId) }),
      ...(activeFile.supportsDocxEdits === undefined
        ? {}
        : { supportsDocxEdits: activeFile.supportsDocxEdits }),
      ...(activeFile.docxEditSnapshot === undefined
        ? {}
        : {
            docxEditSnapshot: toChatSendDocxEditSnapshot(
              activeFile.docxEditSnapshot,
            ),
          }),
    };
  }

  const activeDraft = context?.getActiveDraft?.();
  if (activeDraft) {
    body.activeDraft = {
      fileName: activeDraft.fileName,
      originChatMessageId: toSafeId<"chatMessage">(
        activeDraft.originChatMessageId,
      ),
      originChatThreadId: toSafeId<"chatThread">(
        activeDraft.originChatThreadId,
      ),
      toolCallId: activeDraft.toolCallId,
      docxEditSnapshot: toChatSendDocxEditSnapshot(
        activeDraft.docxEditSnapshot,
      ),
    };
  }

  const activeDecision = context?.getActiveDecision?.();
  if (activeDecision) {
    body.activeDecision = {
      decisionId: toSafeId<"caseLawDecision">(activeDecision.decisionId),
    };
  }

  const activeExternal = context?.getActiveExternal?.();
  if (activeExternal) {
    body.activeExternal = {
      title: activeExternal.title,
      url: activeExternal.url,
      ...(activeExternal.connectorSlug === undefined
        ? {}
        : { connectorSlug: activeExternal.connectorSlug }),
      ...(activeExternal.provider === undefined
        ? {}
        : { provider: activeExternal.provider }),
      ...(activeExternal.snippet === undefined
        ? {}
        : { snippet: activeExternal.snippet }),
      ...(activeExternal.sourceToolName === undefined
        ? {}
        : { sourceToolName: activeExternal.sourceToolName }),
      ...(activeExternal.text === undefined
        ? {}
        : { text: activeExternal.text }),
    };
  }

  const activeSkill = context?.getActiveSkill?.();
  if (activeSkill) {
    body.activeSkill = {
      skillName: activeSkill.skillName,
      ...(activeSkill.skillId === undefined
        ? {}
        : { skillId: toSafeId<"agentSkill">(activeSkill.skillId) }),
    };
  }

  const activeStatute = context?.getActiveStatute?.();
  if (activeStatute) {
    body.activeStatute = {
      documentId: toSafeId<"legislationDocument">(activeStatute.documentId),
    };
  }

  const activeTemplate = context?.getActiveTemplate?.();
  if (activeTemplate) {
    body.activeTemplate = {
      fileName: activeTemplate.fileName,
      templateId: toSafeId<"template">(activeTemplate.templateId),
      ...(activeTemplate.docxEditSnapshot === undefined
        ? {}
        : {
            docxEditSnapshot: toChatSendDocxEditSnapshot(
              activeTemplate.docxEditSnapshot,
            ),
          }),
    };
  }

  const contextMatterIds = context?.getContextMatterIds?.();
  if (contextMatterIds !== undefined) {
    body.contextMatterIds = contextMatterIds.map((id) =>
      toSafeId<"workspace">(id),
    );
  }
};

const getRequestSendMode = (
  requestBody: ChatContinuationRequestBody | undefined,
): ChatSendMode | null => requestBody?.sendMode ?? null;

type ResolveChatRequestSendModeProps = {
  context: ChatThreadOptionsContext | undefined;
  key: ChatThreadKey;
  messages: readonly PersistedChatMessage[];
  requestBody: ChatContinuationRequestBody | undefined;
};

const resolveChatRequestSendMode = ({
  context,
  key,
  messages,
  requestBody,
}: ResolveChatRequestSendModeProps): ChatSendMode => {
  const explicitSendMode = getRequestSendMode(requestBody);
  const threadKey = getChatThreadKey(key);
  const userMessageId = getLatestUserMessageId(messages);
  const activeTurn = activeTurnSendModes.get(threadKey);
  const sendMode =
    explicitSendMode ??
    (activeTurn?.userMessageId === userMessageId
      ? activeTurn.sendMode
      : null) ??
    context?.getSendMode?.() ??
    CHAT_SEND_MODE.rawOverride;

  if (userMessageId) {
    activeTurnSendModes.set(threadKey, { sendMode, userMessageId });
  }

  return sendMode;
};

const getLatestUserMessageId = (
  messages: readonly PersistedChatMessage[],
): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (message?.role === "user") {
      return message.id;
    }
  }

  return null;
};

const activeTurnSendModes = new LifecycleRegistry<
  string,
  { sendMode: ChatSendMode; userMessageId: string }
>();

type ActiveTurnDocxEditPreferences = {
  docxEditRepresentation: DocxEditRepresentation | undefined;
  editApplyMode: ChatEditApplyMode | undefined;
  userMessageId: string;
};

const activeTurnDocxEditPreferences = new LifecycleRegistry<
  string,
  ActiveTurnDocxEditPreferences
>();

const resolveChatRequestDocxEditPreferences = ({
  context,
  key,
  messages,
  requestBody,
}: ResolveChatRequestSendModeProps): Omit<
  ActiveTurnDocxEditPreferences,
  "userMessageId"
> => {
  const threadKey = getChatThreadKey(key);
  const userMessage = getLatestUserMessage(messages);
  const userMessageId = userMessage?.id ?? null;
  const activeTurn = activeTurnDocxEditPreferences.get(threadKey);
  const persistedPreferences = userMessage?.metadata?.docxEditPreferences;
  let preferences: Omit<ActiveTurnDocxEditPreferences, "userMessageId">;
  if (requestBody?.editApplyMode !== undefined) {
    preferences = {
      editApplyMode: requestBody.editApplyMode,
      docxEditRepresentation: requestBody.docxEditRepresentation,
    };
  } else if (
    userMessageId !== null &&
    activeTurn?.userMessageId === userMessageId
  ) {
    preferences = activeTurn;
  } else if (persistedPreferences !== undefined) {
    preferences = {
      editApplyMode: persistedPreferences.editApplyMode,
      docxEditRepresentation: persistedPreferences.docxEditRepresentation,
    };
  } else {
    preferences = {
      editApplyMode: context?.getEditApplyMode?.(),
      docxEditRepresentation: context?.getDocxEditRepresentation?.(),
    };
  }

  if (userMessageId !== null) {
    activeTurnDocxEditPreferences.set(threadKey, {
      ...preferences,
      userMessageId,
    });
  }

  return preferences;
};

const getLatestUserMessage = (
  messages: readonly PersistedChatMessage[],
): PersistedChatMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (message?.role === "user") {
      return message;
    }
  }

  return undefined;
};

const normalizeChatContinuationRequestBody = (
  data: unknown,
): ChatContinuationRequestBody | undefined => {
  if (!isRecord(data)) {
    return undefined;
  }

  const body: ChatContinuationRequestBody = {};
  if (
    data["editApplyMode"] === CHAT_EDIT_APPLY_MODE.auto ||
    data["editApplyMode"] === CHAT_EDIT_APPLY_MODE.manual
  ) {
    body.editApplyMode = data["editApplyMode"];
  }
  if (
    data["docxEditRepresentation"] ===
      DOCX_EDIT_REPRESENTATION.trackedChanges ||
    data["docxEditRepresentation"] === DOCX_EDIT_REPRESENTATION.direct
  ) {
    body.docxEditRepresentation = data["docxEditRepresentation"];
  }
  if (isChatSendMode(data["sendMode"])) {
    body.sendMode = data["sendMode"];
  }
  if (data["toolScope"] === SUGGEST_TEMPLATE_FIELDS_TOOL_SCOPE) {
    body.toolScope = data["toolScope"];
  }
  if (typeof data["truncateAfterMessageId"] === "string") {
    body.truncateAfterMessageId = toSafeId<"chatMessage">(
      data["truncateAfterMessageId"],
    );
  }
  if (data["turnIntent"] === CHAT_TURN_INTENT.regenerate) {
    body.turnIntent = data["turnIntent"];
  }

  return Object.keys(body).length === 0 ? undefined : body;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const resetChatRequestStateForTests = (): void => {
  activeTurnDocxEditPreferences.clear();
  activeTurnSendModes.clear();
};
