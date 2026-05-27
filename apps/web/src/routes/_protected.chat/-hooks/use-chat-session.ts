import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentProps } from "react";

import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { isToolUIPart } from "ai";
import { v7 as uuidv7 } from "uuid";

import type { ChatSendMode } from "@stll/anonymize-chat";

import { AnonymizedSpan } from "@/components/chat/anonymized-span";
import type {
  ApprovalToolName,
  AskUserOutput,
  ChatUITools,
  PersistedChatMessage,
  ToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";
import {
  getExternalMcpConnectorApprovalGrant,
  getExternalMcpConnectorSlugFromToolName,
  getToolApprovalGrant,
  hasRunningToolCallInLatestAssistantMessage,
  isApprovalToolName,
  isExternalMcpToolName,
  isToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";
import { openEntityInInspector } from "@/components/chat/entity-open";
import type { NeedsMatterMatter } from "@/components/chat/needs-matter-card";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { api } from "@/lib/api";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";

type CreateDocumentInput = ChatUITools["create-document"]["input"];
type CreateDocumentOutput = ChatUITools["create-document"]["output"];
type CreateDocumentSuccess = Extract<CreateDocumentOutput, { success: true }>;

type UseChatSessionOptions = {
  chat: Chat<PersistedChatMessage>;
  conversationId: string;
  getSendMode?: (() => ChatSendMode) | undefined;
  workspaceId?: string | undefined;
};

type McpConnectorApprovalIdentity = {
  id: string;
  slug: string;
};

export type ResendLatestMessageOptions = {
  messageId?: string | undefined;
  sendMode?: ChatSendMode | undefined;
};

const EMPTY_MCP_CONNECTOR_IDENTITIES: readonly McpConnectorApprovalIdentity[] =
  [];

/**
 * Payload shape accepted by the AI SDK's `sendMessage`. Surfaces
 * only ever pass `{ text }`, `{ files }`, or `{ text, files }`, but
 * the queue keeps the SDK's full union so it can hold whatever a
 * caller hands `sendMessage`.
 */
type ChatSendMessageInput = NonNullable<
  Parameters<Chat<PersistedChatMessage>["sendMessage"]>[0]
>;
type ChatSendMessageOptions = Parameters<
  Chat<PersistedChatMessage>["sendMessage"]
>[1];

/**
 * A user message composed while a response was still streaming.
 * `useChatSession` holds these in a queue and dispatches them —
 * oldest first — once the turn finishes. `text` is the raw editor
 * HTML (rendered like any sent user message); `fileCount` lets the
 * pending bubble show an attachment hint without the view ever
 * touching the file payloads.
 */
export type QueuedChatMessage = {
  id: string;
  text: string;
  fileCount: number;
};

type QueuedChatEntry = QueuedChatMessage & {
  /** Fully-built payload handed to the AI SDK on dispatch. */
  message: ChatSendMessageInput;
  options: ChatSendMessageOptions;
};

/**
 * Pull a display preview out of an outgoing chat payload. The SDK
 * union has no discriminator, so the `text`/`files` shapes our
 * surfaces send are told apart structurally with `in`.
 */
const describeQueuedMessage = (
  message: ChatSendMessageInput,
): Pick<QueuedChatMessage, "fileCount" | "text"> => ({
  text: "text" in message ? message.text : "",
  fileCount: "files" in message ? message.files.length : 0,
});

export const useChatSession = ({
  chat,
  conversationId,
  getSendMode,
  workspaceId,
}: UseChatSessionOptions) => {
  const organizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: mcpCatalog } = useQuery(mcpConnectorsOptions(organizationId));
  const mcpConnectorIdentities =
    mcpCatalog?.connectors ?? EMPTY_MCP_CONNECTOR_IDENTITIES;
  const [conversationApprovedTools, setConversationApprovedTools] = useState(
    () => readConversationApprovedTools(conversationId),
  );
  const [alwaysApprovedTools, setAlwaysApprovedTools] = useState(() =>
    readAlwaysApprovedTools({ organizationId, mcpConnectorIdentities: [] }),
  );

  const {
    error,
    messages,
    regenerate,
    sendMessage: sendChatMessage,
    stop,
    status,
    addToolApprovalResponse,
    addToolOutput,
  } = useChat({ chat });

  // Mirror `isGenerating` (computed below) and the live queue into
  // refs so the stable `sendMessage` callback can branch on the
  // latest committed values. The refs are updated in effects or
  // queue-event helpers (not during render) so a concurrent re-render
  // that bails out can't strand them ahead of committed state.
  const isGeneratingRef = useRef(false);
  const queueRef = useRef<QueuedChatEntry[]>([]);
  const wasGeneratingRef = useRef(false);
  const conversationIdRef = useRef(conversationId);
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatEntry[]>([]);

  const replaceQueuedMessages = useCallback((next: QueuedChatEntry[]) => {
    queueRef.current = next;
    setQueuedMessages(next);
  }, []);

  const withSendModeSnapshot = useCallback(
    (options: ChatSendMessageOptions): ChatSendMessageOptions => {
      const sendMode = getSendMode?.();
      if (sendMode === undefined) {
        return options;
      }
      return {
        ...options,
        body: {
          sendMode,
          ...options?.body,
        },
      };
    },
    [getSendMode],
  );

  const enqueueMessage = useCallback(
    (message: ChatSendMessageInput, options: ChatSendMessageOptions) => {
      replaceQueuedMessages([
        ...queueRef.current,
        { id: uuidv7(), message, options, ...describeQueuedMessage(message) },
      ]);
    },
    [replaceQueuedMessages],
  );

  const takeOldestQueuedMessage = useCallback(() => {
    const next = queueRef.current.at(0);
    if (!next) {
      return null;
    }
    replaceQueuedMessages(queueRef.current.slice(1));
    return next;
  }, [replaceQueuedMessages]);

  const sendMessage = useCallback(
    async (message: ChatSendMessageInput, options?: ChatSendMessageOptions) => {
      if (conversationIdRef.current !== conversationId) {
        conversationIdRef.current = conversationId;
        isGeneratingRef.current = false;
        wasGeneratingRef.current = false;
        replaceQueuedMessages([]);
      }

      const requestOptions = withSendModeSnapshot(options);
      if (isGeneratingRef.current) {
        enqueueMessage(message, requestOptions);
        return;
      }

      // When the queue is gated after an errored turn, a manual send
      // should resume the queue without reordering the transcript:
      // append the new prompt, then dispatch the oldest waiting one.
      if (queueRef.current.length > 0) {
        enqueueMessage(message, requestOptions);
        const next = takeOldestQueuedMessage();
        if (next) {
          isGeneratingRef.current = true;
          await sendChatMessage(next.message, next.options);
        }
        return;
      }

      await sendChatMessage(message, requestOptions);
    },
    [
      conversationId,
      enqueueMessage,
      replaceQueuedMessages,
      sendChatMessage,
      takeOldestQueuedMessage,
      withSendModeSnapshot,
    ],
  );

  const removeQueuedMessage = useCallback(
    (id: string) => {
      replaceQueuedMessages(
        queueRef.current.filter((entry) => entry.id !== id),
      );
    },
    [replaceQueuedMessages],
  );

  const resendLatestMessage = useCallback(
    async ({ messageId, sendMode }: ResendLatestMessageOptions = {}) => {
      await regenerate({
        ...(messageId === undefined ? {} : { messageId }),
        ...(sendMode === undefined ? {} : { body: { sendMode } }),
      });
    },
    [regenerate],
  );

  const handleApprove = useCallback(
    (id: string, _toolName?: ApprovalToolName) => {
      addToolApprovalResponse({ id, approved: true });
    },
    [addToolApprovalResponse],
  );
  const handleAllowInConversation = useCallback(
    (id: string, toolName: ApprovalToolName) => {
      const next = new Set(conversationApprovedTools).add(
        getToolApprovalGrant(toolName),
      );
      setConversationApprovedTools(next);
      writeStoredApprovedTools(
        getConversationApprovedToolsStorageKey(conversationId),
        next,
        "session",
      );
      dispatchApprovedToolsChanged({
        conversationId,
        scope: "session",
      });
      addToolApprovalResponse({ id, approved: true });
    },
    [addToolApprovalResponse, conversationApprovedTools, conversationId],
  );
  const handleAlwaysAllow = useCallback(
    (id: string, toolName: ApprovalToolName) => {
      const approvalKey = getAlwaysApprovalKey({
        mcpConnectorIdentities,
        organizationId,
        toolName,
      });
      if (approvalKey === null) {
        addToolApprovalResponse({ id, approved: true });
        return;
      }

      const nextStored = new Set(
        readStoredStrings(CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY),
      ).add(approvalKey);
      setAlwaysApprovedTools(
        new Set(alwaysApprovedTools).add(getToolApprovalGrant(toolName)),
      );
      writeStoredApprovedStrings(
        CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY,
        nextStored,
      );
      dispatchApprovedToolsChanged({ scope: "local" });
      addToolApprovalResponse({ id, approved: true });
    },
    [
      addToolApprovalResponse,
      alwaysApprovedTools,
      mcpConnectorIdentities,
      organizationId,
    ],
  );
  const handleDeny = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: false }),
    [addToolApprovalResponse],
  );
  const handleAskUserSubmit = useCallback(
    (toolCallId: string, output: AskUserOutput) =>
      addToolOutput({
        tool: "ask-user",
        toolCallId,
        output,
      }),
    [addToolOutput],
  );

  const { data: workspacesNavigation, isPending: isLoadingMatters } = useQuery(
    workspacesNavigationOptions(organizationId),
  );
  const createDocumentMatters: readonly NeedsMatterMatter[] = useMemo(
    () =>
      workspacesNavigation?.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        color: w.color,
        client: w.client?.displayName
          ? { displayName: w.client.displayName }
          : null,
      })) ?? [],
    [workspacesNavigation],
  );

  const handleCreateDocumentResolve = useCallback(
    async (
      toolCallId: string,
      matterId: string,
      input: CreateDocumentInput,
    ) => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(matterId) })
        ["create-from-legal-source"].post({
          queryKey: entitiesKeys.all(matterId),
          name: input.name,
          source: input.source,
        });

      if (response.error) {
        const apiError = toAPIError(response.error);
        const failure: CreateDocumentOutput = {
          success: false,
          message: apiError.message,
        };
        await addToolOutput({
          tool: "create-document",
          toolCallId,
          output: failure,
        });
        return;
      }

      await addToolOutput({
        tool: "create-document",
        toolCallId,
        output: response.data,
      });
    },
    [addToolOutput],
  );

  const handleOpenCreatedDocument = useCallback(
    async (output: CreateDocumentSuccess) => {
      // Old chat threads predate `entityId`/`workspaceId` on the
      // tool output. Without them we can't open the file, so bail —
      // the card surfaces this by hiding the open affordance.
      if (!output.entityId || !output.workspaceId) {
        return;
      }
      // Pin this chat thread in the workspace inspector. Inherit
      // the thread's existing scope (`workspaceId` arg from the
      // session, may be undefined for a global thread) — claiming
      // the destination matter as the thread's owner triggers a
      // server-side scope-mismatch error in fetchThreadMessages.
      // Seed the chat's matter context so the AI keeps the picked
      // matter in scope without forcing thread ownership.
      const inspector = useInspectorStore.getState();
      inspector.openChat({
        id: toChatThreadId(conversationId),
        ...(workspaceId !== undefined && { workspaceId }),
        contextMatterIds: [output.workspaceId],
      });
      // Keep the user on the chat surface and let the global
      // InspectorPanel (mounted on every protected route) host the
      // file. Tabs carry their own `workspaceId`, so a doc that
      // lives in workspace B while the chat is bound to workspace A
      // (or to no workspace at all) still renders correctly without
      // a route change. `openEntityInInspector` resolves the file
      // field and synchronously calls `openFile`, so the tab is in
      // the store by the time we read it; we then ask the panel to
      // start folio edit mode for whichever PDF tab carries the
      // entity.
      await openEntityInInspector(
        output.entityId,
        output.fileName,
        output.workspaceId,
      );
      const tab = useInspectorStore
        .getState()
        .tabs.find(
          (candidate) =>
            candidate.type === "pdf" && candidate.entityId === output.entityId,
        );
      if (tab) {
        useInspectorStore.getState().requestDocxEdit(tab.id);
      }
    },
    [conversationId, workspaceId],
  );
  const streamdownComponents = useMemo(
    () => ({
      a: (props: ComponentProps<"a">) =>
        createElement(StreamdownMentionLink, {
          ...props,
          interactive: true,
          workspaceId,
        }),
      "stll-anon": (props: ComponentProps<"button"> & { ph?: string }) =>
        createElement(AnonymizedSpan, props),
    }),
    [workspaceId],
  );

  const approvalPendingMessageId = useMemo(
    () => getCurrentApprovalPendingMessageId(messages),
    [messages],
  );

  const hasRunningToolCall = useMemo(
    () => hasRunningToolCallInLatestAssistantMessage({ messages }),
    [messages],
  );
  const isGenerating =
    status === "submitted" || status === "streaming" || hasRunningToolCall;
  useEffect(() => {
    isGeneratingRef.current = isGenerating;
  }, [isGenerating]);
  useEffect(() => {
    queueRef.current = queuedMessages;
  }, [queuedMessages]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
    isGeneratingRef.current = false;
    replaceQueuedMessages([]);
    wasGeneratingRef.current = false;
  }, [conversationId, replaceQueuedMessages]);

  // Drain the queue one message per turn. When the response
  // finishes (`isGenerating` falls back to false) the oldest queued
  // message is dispatched; sending it flips the status straight
  // back, so the next queued message waits for that turn to end
  // too — queued messages never overlap a stream. We hold the
  // queue if the turn ended in error: firing every queued message
  // into a failing provider just burns quota and spams the user
  // with repeats of the same error. The next manual send (or a
  // successful `regenerate`) lifts the gate.
  useEffect(() => {
    const finishedTurn = wasGeneratingRef.current && !isGenerating;
    wasGeneratingRef.current = isGenerating;
    if (!finishedTurn || status === "error") {
      return;
    }
    const next = queuedMessages.at(0);
    if (!next) {
      return;
    }
    replaceQueuedMessages(queuedMessages.slice(1));
    isGeneratingRef.current = true;
    void sendChatMessage(next.message);
  }, [
    isGenerating,
    queuedMessages,
    replaceQueuedMessages,
    sendChatMessage,
    status,
  ]);

  useEffect(() => {
    setConversationApprovedTools(readConversationApprovedTools(conversationId));
    setAlwaysApprovedTools(
      readAlwaysApprovedTools({ organizationId, mcpConnectorIdentities }),
    );
  }, [conversationId, mcpConnectorIdentities, organizationId]);
  useEffect(() => {
    const handleApprovedToolsChanged = (event: Event) => {
      const detail = getApprovedToolsChangedDetail(event);
      if (!detail) {
        return;
      }

      if (detail.scope === "local") {
        setAlwaysApprovedTools(
          readAlwaysApprovedTools({ organizationId, mcpConnectorIdentities }),
        );
        return;
      }

      if (detail.conversationId !== conversationId) {
        return;
      }

      setConversationApprovedTools(
        readConversationApprovedTools(conversationId),
      );
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY) {
        return;
      }

      setAlwaysApprovedTools(
        readAlwaysApprovedTools({ organizationId, mcpConnectorIdentities }),
      );
    };

    window.addEventListener(
      CHAT_APPROVED_TOOLS_CHANGED_EVENT,
      handleApprovedToolsChanged,
    );
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener(
        CHAT_APPROVED_TOOLS_CHANGED_EVENT,
        handleApprovedToolsChanged,
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, [conversationId, mcpConnectorIdentities, organizationId]);

  return {
    error,
    messages,
    resendLatestMessage,
    sendMessage,
    queuedMessages,
    removeQueuedMessage,
    stop,
    isGenerating,
    alwaysApprovedTools,
    conversationApprovedTools,
    handleApprove,
    handleAllowInConversation,
    handleDeny,
    handleAskUserSubmit,
    handleAlwaysAllow,
    handleCreateDocumentResolve,
    handleOpenCreatedDocument,
    createDocumentMatters,
    isLoadingCreateDocumentMatters: isLoadingMatters,
    addToolOutput,
    streamdownComponents,
    approvalPendingMessageId,
  };
};

const CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY =
  "stella.chat.alwaysApprovedTools";
const CHAT_CONVERSATION_APPROVED_TOOLS_STORAGE_KEY_PREFIX =
  "stella.chat.conversationApprovedTools:";
const CHAT_APPROVED_TOOLS_CHANGED_EVENT = "stella:chat-approved-tools-changed";

type ApprovedToolsChangedDetail =
  | {
      scope: "local";
    }
  | {
      scope: "session";
      conversationId: string;
    };

const getConversationApprovedToolsStorageKey = (conversationId: string) =>
  `${CHAT_CONVERSATION_APPROVED_TOOLS_STORAGE_KEY_PREFIX}${conversationId}`;

const readConversationApprovedTools = (conversationId: string) =>
  readStoredApprovedTools(
    getConversationApprovedToolsStorageKey(conversationId),
  );

const readAlwaysApprovedTools = ({
  mcpConnectorIdentities,
  organizationId,
}: {
  mcpConnectorIdentities: readonly McpConnectorApprovalIdentity[];
  organizationId: string;
}) => {
  const stored = readStoredStrings(CHAT_ALWAYS_APPROVED_TOOLS_STORAGE_KEY);
  const approvedTools: ToolApprovalGrant[] = [];

  for (const value of stored) {
    if (isApprovalToolName(value) && !isExternalMcpToolName(value)) {
      approvedTools.push(value);
      continue;
    }

    const scopedMcpTool = parseScopedMcpApprovalKey({
      mcpConnectorIdentities,
      organizationId,
      value,
    });
    if (scopedMcpTool) {
      approvedTools.push(scopedMcpTool);
    }
  }

  return new Set(approvedTools);
};

const getStorage = (scope: "local" | "session") => {
  if (typeof window === "undefined") {
    return null;
  }

  return scope === "local" ? window.localStorage : window.sessionStorage;
};

const readStoredApprovedTools = (
  key: string,
  scope: "local" | "session" = "session",
) => {
  const stored = readStoredStrings(key, scope);
  return new Set(stored.filter(isToolApprovalGrant));
};

const readStoredStrings = (
  key: string,
  scope: "local" | "session" = "local",
) => {
  const storage = getStorage(scope);
  if (!storage) {
    return [];
  }

  const raw = storage.getItem(key);
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
};

const writeStoredApprovedTools = (
  key: string,
  tools: ReadonlySet<ToolApprovalGrant>,
  scope: "local" | "session",
) => {
  const storage = getStorage(scope);
  if (!storage) {
    return;
  }

  storage.setItem(key, JSON.stringify([...tools]));
};

const writeStoredApprovedStrings = (
  key: string,
  values: ReadonlySet<string>,
) => {
  const storage = getStorage("local");
  if (!storage) {
    return;
  }

  storage.setItem(key, JSON.stringify([...values]));
};

const getAlwaysApprovalKey = ({
  mcpConnectorIdentities,
  organizationId,
  toolName,
}: {
  mcpConnectorIdentities: readonly McpConnectorApprovalIdentity[];
  organizationId: string;
  toolName: ApprovalToolName;
}): string | null => {
  if (!isExternalMcpToolName(toolName)) {
    return toolName;
  }

  const connectorSlug = getExternalMcpConnectorSlugFromToolName(toolName);
  if (!connectorSlug) {
    return null;
  }

  const connector = findMcpConnectorIdentity({
    connectorSlug,
    mcpConnectorIdentities,
  });
  if (!connector) {
    return null;
  }

  return [
    "mcp-approval",
    encodeURIComponent(organizationId),
    encodeURIComponent(connector.id),
    encodeURIComponent(connectorSlug),
  ].join(":");
};

const parseScopedMcpApprovalKey = ({
  mcpConnectorIdentities,
  organizationId,
  value,
}: {
  mcpConnectorIdentities: readonly McpConnectorApprovalIdentity[];
  organizationId: string;
  value: string;
}): ToolApprovalGrant | null => {
  const [
    kind,
    encodedOrganizationId,
    encodedConnectorId,
    encodedConnectorSlug,
    extra,
  ] = value.split(":");
  if (
    kind !== "mcp-approval" ||
    encodedOrganizationId !== encodeURIComponent(organizationId) ||
    !encodedConnectorId ||
    !encodedConnectorSlug ||
    extra !== undefined
  ) {
    return null;
  }

  const connectorId = safeDecodeURIComponent(encodedConnectorId);
  const connectorSlug = safeDecodeURIComponent(encodedConnectorSlug);
  if (!connectorId || !connectorSlug) {
    return null;
  }

  const connector = findMcpConnectorIdentity({
    connectorSlug,
    mcpConnectorIdentities,
  });
  if (connector?.id !== connectorId) {
    return null;
  }

  return getExternalMcpConnectorApprovalGrant(connectorSlug);
};

const findMcpConnectorIdentity = ({
  connectorSlug,
  mcpConnectorIdentities,
}: {
  connectorSlug: string;
  mcpConnectorIdentities: readonly McpConnectorApprovalIdentity[];
}) =>
  mcpConnectorIdentities.find(
    (connector) => connector.slug === connectorSlug,
  ) ?? null;

const safeDecodeURIComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const dispatchApprovedToolsChanged = (detail: ApprovedToolsChangedDetail) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(CHAT_APPROVED_TOOLS_CHANGED_EVENT, { detail }),
  );
};

const getApprovedToolsChangedDetail = (
  event: Event,
): ApprovedToolsChangedDetail | null => {
  if (!(event instanceof CustomEvent)) {
    return null;
  }

  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null || !("scope" in detail)) {
    return null;
  }

  if (detail.scope === "local") {
    return { scope: "local" };
  }

  if (
    detail.scope === "session" &&
    "conversationId" in detail &&
    typeof detail.conversationId === "string"
  ) {
    return {
      scope: "session",
      conversationId: detail.conversationId,
    };
  }

  return null;
};

const getCurrentApprovalPendingMessageId = (
  messages: PersistedChatMessage[],
) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages.at(index);
    if (!msg || msg.role !== "assistant") {
      continue;
    }

    for (const part of msg.parts) {
      if (isToolUIPart(part) && part.state === "approval-requested") {
        return msg.id;
      }
    }

    return null;
  }

  return null;
};
