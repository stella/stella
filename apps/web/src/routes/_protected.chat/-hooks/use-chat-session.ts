import {
  createElement,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentProps } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";
import * as v from "valibot";

import type { ChatSendMode } from "@stll/anonymize-chat";
import { stellaToast } from "@stll/ui/components/toast";

import { AnonymizedSpan } from "@/components/chat/anonymized-span";
import type {
  ApprovalToolName,
  AskUserOutput,
  ChatPart,
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
  sanitizeRunningToolCalls,
  withParsedToolCallInputs,
} from "@/components/chat/chat-ui-tools";
import { openEntityInInspector } from "@/components/chat/entity-open";
import type { NeedsMatterMatter } from "@/components/chat/needs-matter-card";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import type {
  ChatEditApplyMode,
  DocxEditRepresentation,
} from "@/lib/chat-edit-mode";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { internalToolErrorMessage, toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { readStoredJson, writeStoredJson } from "@/lib/stored-json";
import {
  createInitialSendQueueState,
  describeQueuedMessage,
  reduceSendQueue,
  snapshotChatRequestOptions,
  type QueuedChatEntry,
  type SendQueueEvent,
  type SendQueueState,
} from "@/routes/_protected.chat/-hooks/use-chat-session-send-queue.logic";
import {
  fetchOlderMessages,
  isChatMessageStartError,
  sendThreadChatMessage,
  type ChatRuntime,
  type ChatSendMessageOptions,
  type ChatUserMessageInput,
} from "@/routes/_protected.chat/-queries";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";

type CreateDocumentInput = ChatUITools["create-document"]["input"];
type CreateDocumentOutput = ChatUITools["create-document"]["output"];
type CreateDocumentSuccess = Extract<CreateDocumentOutput, { success: true }>;

type UseChatSessionOptions = {
  chat: ChatRuntime;
  conversationId: string;
  getDocxEditRepresentation?:
    | (() => DocxEditRepresentation | undefined)
    | undefined;
  getEditApplyMode?: (() => ChatEditApplyMode) | undefined;
  getSendMode?: (() => ChatSendMode) | undefined;
  /** Cursor for the first older page, seeded from the thread fetch. */
  initialOlderCursor: string | null;
  /**
   * Invoked once, at the moment `error` transitions from unset (or from a
   * different error) into a new error — never again for the same error
   * instance on subsequent renders. `error` never arrives pre-set from a
   * cache/hydration path (a freshly seeded or re-seeded runtime always
   * starts with `error: undefined`), so there is no mount case to cover
   * here — only the live transition matters.
   */
  onError?: ((error: Error) => void) | undefined;
  threadRef: ChatThreadRef;
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

// `QueuedChatMessage` is the view-facing shape of a queued entry; the
// canonical definition (plus `QueuedChatEntry` and the send-queue
// reducer) lives in the sibling `.logic.ts` file. Re-exported here so
// existing consumers keep importing it from this hook.
export type { QueuedChatMessage } from "@/routes/_protected.chat/-hooks/use-chat-session-send-queue.logic";

type AskUserToolCallPart = Extract<
  ChatPart,
  { name: "ask-user"; type: "tool-call" }
>;

const resetAskUserToolCall = (
  part: AskUserToolCallPart,
): AskUserToolCallPart => {
  const { output: _discardedOutput, ...partWithoutOutput } = part;
  return { ...partWithoutOutput, state: "input-complete" };
};

const ignoreQueuedDispatchError = (_error: unknown): void => undefined;

export const useChatSession = ({
  chat,
  conversationId,
  getDocxEditRepresentation,
  getEditApplyMode,
  getSendMode,
  initialOlderCursor,
  onError,
  threadRef,
  workspaceId,
}: UseChatSessionOptions) => {
  const t = useTranslations();
  const organizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: mcpCatalog } = useQuery(mcpConnectorsOptions(organizationId));
  const mcpConnectorIdentities =
    mcpCatalog?.connectors ?? EMPTY_MCP_CONNECTOR_IDENTITIES;
  const [conversationApprovedTools, setConversationApprovedTools] = useState(
    () => readConversationApprovedTools(conversationId),
  );
  const [alwaysApprovedTools, setAlwaysApprovedTools] = useState(() =>
    readAlwaysApprovedTools({ organizationId, mcpConnectorIdentities: [] }),
  );

  const snapshot = useSyncExternalStore(
    chat.subscribe,
    chat.getSnapshot,
    chat.getSnapshot,
  );
  const { error, sessionGenerating, status } = snapshot;
  const notifyError = useLatestCallback((nextError: Error) => {
    onError?.(nextError);
  });
  // Latch for the error-transition effect below: `undefined` means "no
  // error has been notified yet" for the current error-free stretch.
  const lastHandledErrorRef = useRef<Error | undefined>(undefined);
  // TanStack only populates a tool-call part's raw `arguments`; its
  // typed `input` is filled here, once, as messages leave the runtime
  // for the UI, so every consumer reads a parsed `input` the same way
  // across live streaming, transcript re-send, and reload. Memoized on
  // the runtime's message identity; unchanged messages keep their refs.
  const messages = useMemo(
    () => withParsedToolCallInputs(snapshot.messages),
    [snapshot.messages],
  );
  const sendChatMessage = useCallback(
    async (message: ChatUserMessageInput, options?: ChatSendMessageOptions) => {
      await sendThreadChatMessage(chat, message, options);
    },
    [chat],
  );
  const setMessages = chat.setMessages;
  const stop = chat.stop;
  const addToolApprovalResponse = chat.addToolApprovalResponse;
  const addToolResult = chat.addToolResult;

  // Load-older paging. `olderCursor` seeds from the thread fetch and advances
  // with each older page. Re-seed whenever a fresh runtime is hydrated — both
  // on thread switch and on a same-thread refetch (sending a message
  // invalidates the thread query, which rebuilds the runtime from the newest
  // page plus a new initial cursor). Keying on conversationId alone would
  // leave the cursor stale after such a refetch, hiding "load earlier" or
  // paging from a stale boundary. `isLoadingOlder` gates the
  // IntersectionObserver trigger and shows the top spinner.
  const [olderCursor, setOlderCursor] = useState(initialOlderCursor);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  // Set after a failed older-page fetch: the cursor is kept for retry, but the
  // auto-trigger is suppressed (see ChatThreadMessages) so a still-visible
  // sentinel cannot loop the request. Cleared on a manual retry or a re-seed.
  const [loadOlderError, setLoadOlderError] = useState(false);
  const [seededChat, setSeededChat] = useState(chat);
  const isLoadingOlderRef = useRef(false);
  const olderCursorRef = useRef(olderCursor);
  // Render-current runtime identity for the stale-response guard below. A fresh
  // runtime means the thread was rehydrated — a thread switch OR a same-thread
  // refetch (sending a message rebuilds the runtime from a newer first page) —
  // so an in-flight older request must be discarded. A thread-id guard would
  // miss the same-thread case. Written during render (not a passive effect) so
  // a response resolving in the commit→effect window is still caught.
  const seededChatRef = useRef(chat);
  if (seededChat !== chat) {
    setSeededChat(chat);
    setOlderCursor(initialOlderCursor);
    setIsLoadingOlder(false);
    setLoadOlderError(false);
    // eslint-disable-next-line react/react-compiler -- deliberate render-time ref write: mirrors the re-seed synchronously so an older-page response resolving in the commit→effect window is discarded by the stale-response guard
    olderCursorRef.current = initialOlderCursor;
    // eslint-disable-next-line react/react-compiler -- deliberate render-time ref write: see above, closes the commit→effect race window for the stale-response guard
    isLoadingOlderRef.current = false;
    // eslint-disable-next-line react/react-compiler -- deliberate render-time ref write: render-current runtime identity for the stale-response guard in loadOlder
    seededChatRef.current = chat;
  }

  const loadOlder = useCallback(async () => {
    const before = olderCursorRef.current;
    if (before === null || isLoadingOlderRef.current) {
      return;
    }
    const requestedChat = seededChatRef.current;
    isLoadingOlderRef.current = true;
    setIsLoadingOlder(true);
    setLoadOlderError(false);

    const result = await Result.tryPromise(
      async () => await fetchOlderMessages({ key: threadRef, before }),
    );

    // Discard a response that resolved after the runtime was rehydrated
    // (thread switch OR same-thread refetch): the re-seed already reset paging
    // for the new page, so applying this would corrupt its cursor and prepend
    // a stale page (skipping the boundary message).
    if (seededChatRef.current !== requestedChat) {
      return;
    }

    isLoadingOlderRef.current = false;
    setIsLoadingOlder(false);

    if (Result.isError(result)) {
      // `fetchOlderMessages` already throws a converted APIError; capture it
      // for telemetry and surface a toast so the user knows the older history
      // failed to load. Keep the cursor but flag the error so auto-loading
      // pauses (the manual button retries) instead of looping the request.
      getAnalytics().captureError(result.error);
      setLoadOlderError(true);
      stellaToast.add({
        title: t("chat.loadEarlierMessagesError"),
        type: "error",
      });
      return;
    }

    const older = result.value;
    const current = chat.getSnapshot().messages;
    const existingIds = new Set(current.map((message) => message.id));
    // Older pages are historical by definition — they can never contain
    // the live turn — so rewriting their dead running tool-call parts is
    // unconditionally safe. `current` is NOT sanitized: its tail may be a
    // live streaming turn.
    const prepend = sanitizeRunningToolCalls(older.messages).filter(
      (message) => !existingIds.has(message.id),
    );
    if (prepend.length > 0) {
      setMessages([...prepend, ...current]);
    }
    olderCursorRef.current = older.olderCursor;
    setOlderCursor(older.olderCursor);
  }, [chat, setMessages, t, threadRef]);

  // Mirror `isGenerating` (computed below) and the live queue into
  // refs so the stable `sendMessage` callback can branch on the
  // latest committed values. The ref is updated in effects or
  // queue-event helpers (not during render) so a concurrent re-render
  // that bails out can't strand it ahead of committed state.
  //
  // The four pieces of queue bookkeeping (generating flag, queue
  // contents, "was generating last check" edge marker, and the
  // conversation the queue belongs to) all live in one
  // `SendQueueState`, and every write goes through `reduceSendQueue` via
  // `applySendQueueEvent` below — see use-chat-session-send-queue.logic.ts.
  // No call site writes a single field by hand anymore, so an exit path
  // can no longer update one without the others.
  const sendQueueRef = useRef<SendQueueState>(
    createInitialSendQueueState(conversationId),
  );
  const [queuedMessages, setQueuedMessages] = useState<
    readonly QueuedChatEntry[]
  >([]);

  const applySendQueueEvent = useCallback((event: SendQueueEvent) => {
    const { state: nextState, dispatchedEntry } = reduceSendQueue(
      sendQueueRef.current,
      event,
    );
    const queueChanged = nextState.queue !== sendQueueRef.current.queue;
    sendQueueRef.current = nextState;
    if (queueChanged) {
      setQueuedMessages(nextState.queue);
    }
    return dispatchedEntry;
  }, []);

  const withRequestSnapshots = useCallback(
    (options?: ChatSendMessageOptions): ChatSendMessageOptions | undefined => {
      const sendMode = getSendMode?.();
      const editApplyMode = getEditApplyMode?.();
      const docxEditRepresentation =
        editApplyMode === undefined ? undefined : getDocxEditRepresentation?.();
      if (sendMode === undefined && editApplyMode === undefined) {
        return options;
      }
      return snapshotChatRequestOptions({
        docxEditRepresentation,
        editApplyMode,
        options,
        sendMode,
      });
    },
    [getDocxEditRepresentation, getEditApplyMode, getSendMode],
  );

  const enqueueMessage = useCallback(
    (message: ChatUserMessageInput, options?: ChatSendMessageOptions) => {
      const entry: QueuedChatEntry = {
        id: uuidv7(),
        message,
        ...describeQueuedMessage(message),
        ...(options === undefined ? {} : { options }),
      };
      applySendQueueEvent({ type: "message-enqueued", entry });
    },
    [applySendQueueEvent],
  );

  const dispatchQueuedMessage = useCallback(
    async (entry: QueuedChatEntry) => {
      try {
        await sendChatMessage(entry.message, entry.options);
      } catch (sendError) {
        applySendQueueEvent({
          type: "dispatch-failed",
          entry,
          requeue: isChatMessageStartError(sendError),
        });
        throw sendError;
      }
    },
    [applySendQueueEvent, sendChatMessage],
  );

  const sendMessage = useCallback(
    async (message: ChatUserMessageInput, options?: ChatSendMessageOptions) => {
      if (sendQueueRef.current.conversationId !== conversationId) {
        applySendQueueEvent({ type: "conversation-switched", conversationId });
      }

      const requestOptions = withRequestSnapshots(options);
      if (sendQueueRef.current.isGenerating) {
        enqueueMessage(message, requestOptions);
        return;
      }

      // When the queue is gated after an errored turn, a manual send
      // should resume the queue without reordering the transcript:
      // append the new prompt, then dispatch the oldest waiting one.
      if (sendQueueRef.current.queue.length > 0) {
        enqueueMessage(message, requestOptions);
        const dispatched = applySendQueueEvent({
          type: "oldest-dispatch-started",
        });
        if (dispatched) {
          await dispatchQueuedMessage(dispatched);
        }
        return;
      }

      await sendChatMessage(message, requestOptions);
    },
    [
      applySendQueueEvent,
      conversationId,
      dispatchQueuedMessage,
      enqueueMessage,
      sendChatMessage,
      withRequestSnapshots,
    ],
  );

  const removeQueuedMessage = useCallback(
    (id: string) => {
      applySendQueueEvent({ type: "queued-message-removed", id });
    },
    [applySendQueueEvent],
  );

  const resendLatestMessage = useCallback(
    async ({ messageId, sendMode }: ResendLatestMessageOptions = {}) => {
      const latestAssistant = messages.findLast(
        (message) => message.role === "assistant",
      );
      if (
        messageId !== undefined &&
        latestAssistant !== undefined &&
        latestAssistant.id !== messageId
      ) {
        return;
      }

      await chat.reload(
        sendMode === undefined ? undefined : { body: { sendMode } },
      );
    },
    [chat, messages],
  );

  const handleApprove = useCallback(
    async (
      id: string,
      _toolName?: ApprovalToolName,
      options?: ChatSendMessageOptions,
    ) => {
      await addToolApprovalResponse({ id, approved: true }, options);
    },
    [addToolApprovalResponse],
  );
  const handleAllowInConversation = useCallback(
    async (id: string, toolName: ApprovalToolName) => {
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
      await addToolApprovalResponse({ id, approved: true });
    },
    [addToolApprovalResponse, conversationApprovedTools, conversationId],
  );
  const handleAlwaysAllow = useCallback(
    async (id: string, toolName: ApprovalToolName) => {
      const approvalKey = getAlwaysApprovalKey({
        mcpConnectorIdentities,
        organizationId,
        toolName,
      });
      if (approvalKey === null) {
        await addToolApprovalResponse({ id, approved: true });
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
      await addToolApprovalResponse({ id, approved: true });
    },
    [
      addToolApprovalResponse,
      alwaysApprovedTools,
      mcpConnectorIdentities,
      organizationId,
    ],
  );
  const handleDeny = useCallback(
    async (id: string) => {
      await addToolApprovalResponse({ id, approved: false });
    },
    [addToolApprovalResponse],
  );
  const handleAskUserSubmit = useCallback(
    async (toolCallId: string, output: AskUserOutput) => {
      await addToolResult({
        tool: "ask-user",
        toolCallId,
        output,
      });
    },
    [addToolResult],
  );

  /**
   * Edit an already-answered ask-user card and replay the model
   * from that point. TanStack ChatClient does not expose a
   * rewind-to-tool-call primitive, so this is a truncate-and-replay:
   *
   *   1. Find the assistant message that owns the ask-user part.
   *   2. Drop every message after it locally; the backend receives
   *      the same truncation target for persisted history.
   *   3. Reset the ask-user `tool-call` to `input-complete` and
   *      remove its paired `tool-result` so `addToolResult` writes
   *      a fresh output and TanStack's continuation logic drives the
   *      next turn.
   *
   * The replay request also carries `truncateAfterMessageId`, so the
   * backend drops persisted downstream turns before preparing the next
   * model context.
   */
  const handleAskUserEditAndRerun = useCallback(
    async (toolCallId: string, output: AskUserOutput) => {
      let targetIndex = -1;
      for (let i = 0; i < messages.length; i += 1) {
        const candidate = messages[i];
        if (!candidate || candidate.role !== "assistant") {
          continue;
        }
        const hasPart = candidate.parts.some(
          (part) =>
            part.type === "tool-call" &&
            part.name === "ask-user" &&
            part.id === toolCallId,
        );
        if (hasPart) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex === -1) {
        return;
      }
      const targetMessage = messages[targetIndex];
      if (!targetMessage || targetMessage.role !== "assistant") {
        return;
      }

      // SAFETY: spreading inside `.map` is flagged by no-map-spread,
      // but slice's elements are shared refs with the original
      // `messages` array — mutating in place would corrupt the
      // SDK's history. The spread builds a new message object that
      // owns the rewritten parts array.
      const truncated = messages
        .slice(0, targetIndex + 1)
        // eslint-disable-next-line oxc/no-map-spread -- intentionally builds a new message object to avoid mutating SDK history
        .map((message) => {
          if (message.role !== "assistant") {
            return message;
          }
          // Reset the matching ask-user part so `addToolResult` can
          // overwrite its output. Keeping `input` on the tool-call
          // keeps the card body stable during the brief frame between
          // truncation and the next tool-result write.
          const nextParts: ChatPart[] = [];
          for (const part of message.parts) {
            if (part.type === "tool-result" && part.toolCallId === toolCallId) {
              continue;
            }
            if (
              part.type === "tool-call" &&
              part.name === "ask-user" &&
              part.id === toolCallId &&
              part.state === "complete"
            ) {
              nextParts.push(resetAskUserToolCall(part));
              continue;
            }
            nextParts.push(part);
          }
          return { ...message, parts: nextParts };
        });
      setMessages(truncated);
      const replayOptions = snapshotChatRequestOptions({
        docxEditRepresentation: undefined,
        editApplyMode: undefined,
        options: {
          body: {
            truncateAfterMessageId: toSafeId<"chatMessage">(targetMessage.id),
          },
        },
        sendMode: getSendMode?.(),
      });
      await addToolResult(
        {
          tool: "ask-user",
          toolCallId,
          output,
        },
        replayOptions,
      );
    },
    [addToolResult, getSendMode, messages, setMessages],
  );

  const { data: workspacesNavigation, isPending: isLoadingMatters } = useQuery(
    workspacesNavigationOptions(organizationId),
  );
  const createDocumentMatters: readonly NeedsMatterMatter[] = useMemo(() => {
    if (!workspacesNavigation) {
      return [];
    }
    return workspacesNavigation.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      color: w.color,
      client: w.client?.displayName
        ? { displayName: w.client.displayName }
        : null,
    }));
  }, [workspacesNavigation]);

  const queryClient = useQueryClient();
  const handledDocxReplacementToolCallIdsRef = useRef(new Set<string>());

  // Server-side automatic DOCX edits replace the entity's file field. Follow
  // that replacement immediately in the inspector and refresh entity-backed
  // routes; otherwise an open tab keeps addressing the stale field until a
  // later navigation. The backend moves the file-chat mapping in the same
  // transaction, so resolving the new field id preserves this conversation.
  useExternalSyncEffect(() => {
    let shouldInvalidateEntities = false;

    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }
      for (const part of message.parts) {
        if (
          part.type !== "tool-call" ||
          part.name !== "edit_workspace_document" ||
          part.state !== "complete" ||
          part.output === undefined ||
          !part.output.success ||
          typeof part.output.replacedFieldId !== "string" ||
          typeof part.output.fieldId !== "string" ||
          handledDocxReplacementToolCallIdsRef.current.has(part.id)
        ) {
          continue;
        }

        handledDocxReplacementToolCallIdsRef.current.add(part.id);
        useInspectorStore
          .getState()
          .replaceFileFieldId(part.output.replacedFieldId, part.output.fieldId);
        shouldInvalidateEntities = true;
      }
    }

    if (shouldInvalidateEntities && workspaceId !== undefined) {
      detached(
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        "useChatSession.editWorkspaceDocumentReplacement",
      );
    }
  }, [messages, queryClient, workspaceId]);

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
          message: internalToolErrorMessage(apiError),
        };
        await addToolResult({
          tool: "create-document",
          toolCallId,
          output: failure,
        });
        return;
      }

      // Prime the file-bytes cache the moment the server returns —
      // there's typically a multi-second gap before the user clicks
      // "Open in editor", and the docx editor's biggest mount cost
      // is the presigned URL roundtrip + S3 download. We kick this
      // off as a fire-and-forget; failures are silent because the
      // editor will retry the same query on mount.
      if (typeof response.data.fieldId === "string") {
        detached(
          queryClient.prefetchQuery(
            fileOptions({
              workspaceId: matterId,
              fieldId: response.data.fieldId,
              purpose: "native-display",
            }),
          ),
          "useChatSession",
        );
      }

      await addToolResult({
        tool: "create-document",
        toolCallId,
        output: response.data,
      });
    },
    [addToolResult, queryClient],
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
      // Keep the user on the chat surface and let the global
      // InspectorPanel (mounted on every protected route) host the
      // file. Tabs carry their own `workspaceId`, so a doc that
      // lives in workspace B while the chat is bound to workspace A
      // (or to no workspace at all) still renders correctly without
      // a route change. Skip pinning the chat as a separate inspector
      // tab — the user is already in this chat as the main surface,
      // so a duplicate chat tab in the side panel reads as confusing
      // ("the doc AND the same chat I am in"). `openEntityInInspector`
      // resolves the file field and synchronously calls `openFile`,
      // so the tab is in the store by the time we read it; we then
      // ask the panel to start folio edit mode for whichever PDF tab
      // carries the entity.
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
    [],
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
    error === undefined &&
    (status === "submitted" ||
      status === "streaming" ||
      sessionGenerating ||
      hasRunningToolCall);
  useExternalSyncEffect(() => {
    applySendQueueEvent({ type: "generation-status-synced", isGenerating });
  }, [applySendQueueEvent, isGenerating]);

  // Notify `onError` exactly once per new error instance. TanStack keeps
  // the same Error reference alive across renders until the turn is
  // retried or cleared, so a ref latch (not `useState`) distinguishes "the
  // same failed turn is still showing" from "a fresh failure just landed."
  // `notifyError` has a stable identity from `useLatestCallback` (it always
  // reads the latest `onError`), so listing it below is a formality: it
  // never changes and so never re-triggers this effect on its own.
  useExternalSyncEffect(() => {
    if (!error) {
      lastHandledErrorRef.current = undefined;
      return;
    }
    if (lastHandledErrorRef.current === error) {
      return;
    }
    lastHandledErrorRef.current = error;
    notifyError(error);
  }, [error, notifyError]);

  useExternalSyncEffect(() => {
    applySendQueueEvent({ type: "conversation-switched", conversationId });
  }, [applySendQueueEvent, conversationId]);

  // Drain the queue one message per turn. When the response
  // finishes (`isGenerating` falls back to false) the oldest queued
  // message is dispatched; sending it flips the status straight
  // back, so the next queued message waits for that turn to end
  // too — queued messages never overlap a stream. We hold the
  // queue if the turn ended in error: firing every queued message
  // into a failing provider just burns quota and spams the user
  // with repeats of the same error. The next manual send (or a
  // successful `regenerate`) lifts the gate. `reduceSendQueue` owns the
  // finished-turn edge detection and the error gate (see
  // `turn-boundary-checked` in use-chat-session-send-queue.logic.ts);
  // this effect only forwards the runtime's latest status and, if a
  // dispatch was returned, sends it.
  useExternalSyncEffect(() => {
    const dispatched = applySendQueueEvent({
      type: "turn-boundary-checked",
      isGenerating,
      status,
    });
    if (!dispatched) {
      return;
    }
    // Preserve the request options the message was queued with —
    // notably `body.sendMode` and the DOCX edit preferences snapshotted by
    // withRequestSnapshots at queue time. The manual drain path
    // already passes them; the automatic drain must too, otherwise
    // toggling the mode between queueing and draining sends the
    // queued turn with the wrong mode.
    detached(
      dispatchQueuedMessage(dispatched).catch(ignoreQueuedDispatchError),
      "useChatSession",
    );
  }, [
    applySendQueueEvent,
    dispatchQueuedMessage,
    isGenerating,
    // Not read in the body — `sendQueueRef` is always current — but kept
    // as a dependency so this effect still re-runs on every queue change,
    // matching the original effect's re-run cadence 1:1.
    queuedMessages,
    status,
  ]);

  useExternalSyncEffect(() => {
    setConversationApprovedTools(readConversationApprovedTools(conversationId));
    setAlwaysApprovedTools(
      readAlwaysApprovedTools({ organizationId, mcpConnectorIdentities }),
    );
  }, [conversationId, mcpConnectorIdentities, organizationId]);
  useExternalSyncEffect(() => {
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
    loadOlder,
    olderCursor,
    isLoadingOlder,
    loadOlderError,
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
    handleAskUserEditAndRerun,
    handleAlwaysAllow,
    handleCreateDocumentResolve,
    handleOpenCreatedDocument,
    createDocumentMatters,
    isLoadingCreateDocumentMatters: isLoadingMatters,
    addToolResult,
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

// Top-level shape only: elements are filtered to strings below, so one
// non-string entry drops just that entry rather than the whole list.
const JsonArraySchema = v.array(v.unknown());

const readStoredStrings = (
  key: string,
  scope: "local" | "session" = "local",
) => {
  const storage = getStorage(scope);
  if (!storage) {
    return [];
  }

  const raw = storage.getItem(key);
  const parsed = readStoredJson(raw, JsonArraySchema);
  return parsed
    ? parsed.filter((value): value is string => typeof value === "string")
    : [];
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

  writeStoredJson(storage, key, [...tools]);
};

const writeStoredApprovedStrings = (
  key: string,
  values: ReadonlySet<string>,
) => {
  const storage = getStorage("local");
  if (!storage) {
    return;
  }

  writeStoredJson(storage, key, [...values]);
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
      if (part.type === "tool-call" && part.state === "approval-requested") {
        return msg.id;
      }
    }

    return null;
  }

  return null;
};
