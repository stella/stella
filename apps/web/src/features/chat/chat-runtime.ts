import type { ModelMessage } from "@tanstack/ai";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import type {
  ChatClientState,
  ChatInterruptState,
  ConnectConnectionAdapter,
  MultimodalContent,
  RunAgentInputContext,
  UIMessage,
} from "@tanstack/ai-client";
import { panic, Result } from "better-result";

import { CHAT_SEND_MODE, isChatSendMode } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import {
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
  CHAT_TURN_ID_HEADER,
  CHAT_TURN_INTENT,
} from "@stll/api-contract";
import type { ChatSendRequest } from "@stll/api-contract";

import type {
  ChatClientTools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import {
  hasRunningToolCallInLatestAssistantMessage,
  isChatClientRequestActive,
} from "@/components/chat/chat-ui-tools";
import { createBrowserClientTool } from "@/features/chat/browser-control/browser-client-tool";
import { getBrowserClientCapability } from "@/features/chat/browser-control/browser-extension-bridge";
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
import { APIError, toAPIError } from "@/lib/errors/api";
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
type ChatStopState =
  | { status: "idle" }
  | { status: "pending"; turnId: SafeId<"chatTurn"> }
  | { error: Error; status: "failed"; turnId: SafeId<"chatTurn"> };

type ChatRuntimeSnapshot = {
  error: Error | undefined;
  isLoading: boolean;
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
  stop: () => void;
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

type CreateChatRuntimeProps = {
  /** The thread's turn not yet settled when the page loaded, which Stop
   *  cancels until a request names a newer one. */
  activeTurnId: SafeId<"chatTurn"> | null;
  context: ChatThreadOptionsContext | undefined;
  initialMessages: PersistedChatMessage[];
  key: ChatThreadKey;
  onError: (error: Error) => void;
  onFinish: () => void;
  /** The stopped turn is settled on the server: reload the thread from it. */
  onTurnStopped: () => void;
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

/** How often, and how many times, a Stop the server accepted but has not
 *  settled yet (its run lives on another instance) asks again. */
const STOP_SETTLE_POLL_MS = 500;
const STOP_SETTLE_POLL_ATTEMPTS = 20;

const waitMs = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
  const sent = await Result.tryPromise(async () => {
    const { data, error } = await api.chat
      .threads({ threadId: toSafeId<"chatThread">(threadId) })
      .turns({ turnId })
      .cancel.post();
    if (error) {
      return Result.err(toAPIError(error));
    }
    const answer = data.turn.status === "running" ? "running" : "settled";
    return Result.ok(answer);
  });
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
  onTurnStopped,
}: CreateChatRuntimeProps): ChatRuntime => {
  const listeners = new Set<() => void>();
  let activeToolResultOperation: ActiveToolResultOperation | undefined;
  let toolResultQueue = Promise.resolve();
  let snapshot: ChatRuntimeSnapshot = {
    error: undefined,
    isLoading: false,
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
  const isStoppedTurn = (): boolean =>
    stoppedTurnId !== null && stoppedTurnId === turnId;
  /** A new message starts a new turn: until the server names it, Stop can
   *  only close the request, and a stop of the previous turn is over. */
  const startTurn = (): void => {
    turnId = null;
    stoppedTurnId = null;
    if (snapshot.stop.status !== "idle") {
      setSnapshot({ stop: { status: "idle" } });
    }
  };

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
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
      }
      return response;
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch;
  const upstreamConnection = fetchServerSentEvents(getChatApiPath(), {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    fetchClient: turnObservingFetchClient,
  });
  const connection = {
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

  const client = new ChatClient<ChatClientTools, unknown, readonly []>({
    threadId: key.threadId,
    initialMessages,
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
      if (error === undefined || !isStoppedTurn()) {
        setSnapshot({ error });
      }
    },
    onFinish: () => {
      onFinish();
    },
    onInterruptStateChange: observeInterruptSubmission,
    onLoadingChange: (isLoading) => {
      setSnapshot({
        isLoading,
        ...(isLoading ? { turnAbandoned: false } : {}),
      });
    },
    onMessagesChange: (messages) => {
      setSnapshot({ messages: toPersistedChatMessages(messages) });
    },
    onSessionGeneratingChange: (sessionGenerating) =>
      setSnapshot({ sessionGenerating }),
    onStatusChange: (status) => setSnapshot({ status }),
    tools: [createBrowserClientTool()],
  });

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

  const startClientSend = (
    message: ChatUserMessageInput,
    options: ChatSendMessageOptions | undefined,
  ): ChatRouteHandoffStart => {
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
    await withBody(options, async () => {
      const interrupt = client
        .getInterrupts()
        .find(
          (candidate) =>
            (candidate.kind === "tool-approval" &&
              candidate.toolCallId === response.id) ||
            (candidate.kind === "generic" &&
              (candidate.interruptId === response.id ||
                candidate.id === response.id)),
        );
      if (interrupt?.kind === "tool-approval") {
        await resolveNativeInterrupt(() => {
          if (response.approved) {
            interrupt.resolveInterrupt(true);
          } else {
            interrupt.resolveInterrupt(false);
          }
        });
        return;
      }
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
      await waitMs(STOP_SETTLE_POLL_MS);
      answer = await requestChatTurnStop({
        threadId: key.threadId,
        turnId: stoppedTurn,
      });
    }
    if (!isCurrent()) {
      return;
    }
    setSnapshot({ stop: { status: "idle" } });
    onTurnStopped();
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
      const turnWasActive =
        snapshot.isLoading ||
        snapshot.sessionGenerating ||
        isChatClientRequestActive(snapshot.status) ||
        hasRunningToolCallInLatestAssistantMessage({
          messages: snapshot.messages,
        });
      if (!turnWasActive) {
        client.stop();
        return;
      }
      // Shown stopped at once. The server decides how the turn ends, and the
      // thread is reloaded from it once it has: a local rewrite of the
      // stopped parts would differ from what a reload shows.
      setSnapshot({ turnAbandoned: true });
      const stoppedTurn = turnId;
      if (stoppedTurn === null) {
        // The server has not named the turn yet, so nothing has streamed:
        // closing the request is all that can stop it.
        client.stop();
        onTurnStopped();
        return;
      }
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies ChatRuntime;

  threadSendMessageByRuntime.set(runtime, sendThreadMessage);

  return runtime;
};

const toPersistedChatMessages = (
  messages: readonly UIMessage<ChatClientTools>[],
): PersistedChatMessage[] => [...messages];

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
      skillId: toSafeId<"agentSkill">(activeSkill.skillId),
      skillName: activeSkill.skillName,
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
