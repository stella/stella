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
import { panic } from "better-result";

import { CHAT_SEND_MODE, isChatSendMode } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import { CHAT_TURN_INTENT } from "@stll/api-contract";
import type { ChatSendRequest } from "@stll/api-contract";

import type {
  ChatClientTools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import {
  hasRunningToolCallInLatestAssistantMessage,
  isChatClientRequestActive,
  sanitizeRunningToolCalls,
} from "@/components/chat/chat-ui-tools";
import { createBrowserClientTool } from "@/features/chat/browser-control/browser-client-tool";
import { getBrowserClientCapability } from "@/features/chat/browser-control/browser-extension-bridge";
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
import { ClientOperationError } from "@/lib/errors/client";
import { fetchWithTimeout } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";

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

type ChatRuntimeSnapshot = {
  error: Error | undefined;
  isLoading: boolean;
  messages: PersistedChatMessage[];
  sessionGenerating: boolean;
  status: ChatClientState;
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

// Matches the backend's own AI-call budget (send-message.ts'
// CHAT_METERED_AI_TIMEOUT_MS) so the client doesn't cut a slow-but-healthy
// model response off before the server would.
const CHAT_FETCH_TIMEOUT_MS = 600_000;

type CreateChatRuntimeProps = {
  context: ChatThreadOptionsContext | undefined;
  initialMessages: PersistedChatMessage[];
  key: ChatThreadKey;
  onError: (error: Error) => void;
  onFinish: () => void;
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

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
  context,
  initialMessages,
  key,
  onError,
  onFinish,
}: CreateChatRuntimeProps): ChatRuntime => {
  const listeners = new Set<() => void>();
  let snapshot: ChatRuntimeSnapshot = {
    error: undefined,
    isLoading: false,
    messages: initialMessages,
    sessionGenerating: false,
    status: "ready",
    turnAbandoned: false,
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

  const reportRuntimeError = (error: unknown): void => {
    captureRuntimeError(error);
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
    if (waiter.sawResuming) {
      interruptSubmissionWaiter = undefined;
      for (const resolution of waiter.resolutions) {
        resolution.resolve();
      }
    }
  };

  const chatFetchClient = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const { signal, ...requestInit } = init ?? {};
      return await fetchWithTimeout(input, {
        ...requestInit,
        ...(signal === null ? {} : { signal }),
        timeoutMs: CHAT_FETCH_TIMEOUT_MS,
      });
    },
    // Bun augments the global fetch type with this optional optimization.
    // TanStack accepts `typeof globalThis.fetch`; the browser transport does
    // not need preconnection, so expose a typed no-op instead of casting.
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch;
  const upstreamConnection = fetchServerSentEvents(getChatApiPath(), {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    fetchClient: chatFetchClient,
  });
  const connection = {
    connect: (messages, data, abortSignal, runContext) => {
      if (runContext === undefined) {
        return panic("TanStack connection omitted the AG-UI run context");
      }
      if (!messages.every(isChatUiMessage)) {
        return panic("Stella chat connection received model messages");
      }
      return upstreamConnection.connect(
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
      );
    },
  } satisfies ConnectConnectionAdapter;

  const client = new ChatClient<ChatClientTools, unknown, readonly []>({
    threadId: key.threadId,
    initialMessages,
    connection,
    onError: (error) => {
      onError(error);
      setSnapshot({ error });
    },
    onErrorChange: (error) => setSnapshot({ error }),
    onFinish: () => {
      onFinish();
    },
    onInterruptStateChange: observeInterruptSubmission,
    onLoadingChange: (isLoading) =>
      setSnapshot({
        isLoading,
        ...(isLoading ? { turnAbandoned: false } : {}),
      }),
    onMessagesChange: (messages) =>
      setSnapshot({ messages: toPersistedChatMessages(messages) }),
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

  const sendThreadMessage: ChatThreadSendMessage = async (message, options) => {
    const stream = client.sendMessage(message, options?.body);

    if (!hasUserMessage(snapshot.messages, message.id)) {
      detached(stream.catch(ignoreAbandonedStreamError), "chat-queries.stream");
      const error = new ChatMessageStartError(message.id);
      captureRuntimeError(error);
      throw error;
    }

    try {
      await stream;
    } catch (error) {
      throw captureRuntimeError(error);
    }
  };

  const runtime = {
    [CHAT_RUNTIME_BRAND]: true,
    resolveToolApproval: async (response, options) => {
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
    },
    addToolResult: async (result, options) => {
      await withBody(options, async () => {
        await client.addToolResult({
          tool: result.tool,
          toolCallId: result.toolCallId,
          output: result.output,
          ...(result.state === undefined ? {} : { state: result.state }),
          ...(result.errorText === undefined
            ? {}
            : { errorText: result.errorText }),
        });
      });
    },
    getSnapshot: () => snapshot,
    reload: async (options) => {
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
      const stream = client.sendMessage(message, options?.body);

      if (!hasUserMessage(snapshot.messages, message.id)) {
        detached(
          stream.catch(ignoreAbandonedStreamError),
          "chat-queries.stream",
        );
        throw captureRuntimeError(new ChatMessageStartError(message.id));
      }

      detached(stream.catch(reportRuntimeError), "chat-queries.stream");
      return { messageId: message.id, status: "started", stream };
    },
    stop: () => {
      const turnWasActive =
        snapshot.isLoading ||
        snapshot.sessionGenerating ||
        isChatClientRequestActive(snapshot.status) ||
        hasRunningToolCallInLatestAssistantMessage({
          messages: snapshot.messages,
        });
      client.stop();
      // `client.stop()` aborts the live request but never rewrites message
      // parts, so a tool-call part caught mid-run stays in a running state and
      // keeps `hasRunningToolCallInLatestAssistantMessage` — and thus
      // `isGenerating` — stuck true, wedging the composer on Stop/spinner with
      // the tool card spinning forever. When the aborted turn had a running
      // tool call, finalize it the same way the hydration path does so the
      // turn actually ends.
      if (
        hasRunningToolCallInLatestAssistantMessage({
          messages: snapshot.messages,
        })
      ) {
        const sanitized = sanitizeRunningToolCalls(snapshot.messages, "cancel");
        client.setMessagesManually(sanitized);
        setSnapshot({ messages: sanitized });
      }
      if (turnWasActive) {
        setSnapshot({ turnAbandoned: true });
      }
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

export class LifecycleRegistry<K, V> {
  private readonly entries = new Map<K, V>();

  get(key: K) {
    return this.entries.get(key);
  }

  set(key: K, value: V) {
    this.entries.set(key, value);
  }

  delete(key: K) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  values() {
    return this.entries.values();
  }

  [Symbol.iterator]() {
    return this.entries[Symbol.iterator]();
  }
}

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
