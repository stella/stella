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
import {
  resourceRef,
  RESOURCE_TYPE,
  toChatResourceHref,
} from "@stll/api-contract";
import { stellaToast } from "@stll/ui/toast";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
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
  getChatAssistantTurnError,
  getExternalMcpConnectorSlugFromToolName,
  getToolApprovalGrant,
  hasRunningToolCallInLatestAssistantMessage,
  isApprovalToolName,
  isChatClientRequestActive,
  isExternalMcpToolName,
  isSuggestChangesApplyOutput,
  isToolApprovalGrant,
  projectCanonicalChatUIMessages,
  sanitizeRunningToolCalls,
  SUGGEST_CHANGES_TOOL_NAME,
} from "@/components/chat/chat-ui-tools";
import {
  beginCreateDocumentDraftPersistence,
  completeCreateDocumentDraft,
  endCreateDocumentDraftPersistence,
  getBoundCreateDocumentDraftChatThreadId,
  getCreateDocumentDraftPersistence,
  prepareCreateDocumentDraft as prepareCreateDocumentDraftBuffer,
  settleCreateDocumentDraftWithRetry,
} from "@/components/chat/create-document-draft-runtime";
import "@/components/chat/create-document-draft-inspector";
import {
  buildCreateDocumentDraftPayload,
  buildCreateDocumentDownloadFileName,
  CREATE_DOCUMENT_DRAFT_VIEW,
  createDocumentDraftReviewId,
  createDocumentDraftTabId,
  type CreateDocumentDraft,
  findReadyCreateDocumentDraftMessageId,
  isCreateDocumentDraftPayload,
  isCreateDocumentDraftSettlementActive,
  isSameCreateDocumentDraftPayload,
  replaceReadyCreateDocumentDraftOutput,
  selectCreateDocumentDrafts,
  selectTerminalCreateDocumentDraftIds,
  selectSettleableCreateDocumentDrafts,
  setCreateDocumentDraftPayloadStatus,
  terminalizeUnsettledCreateDocumentDraft,
} from "@/components/chat/create-document-draft.logic";
import { openEntityInInspector } from "@/components/chat/entity-open";
import type {
  CreateDocumentDestination,
  NeedsMatterMatter,
} from "@/components/chat/needs-matter-card";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  isChatMessageStartError,
  sendThreadChatMessage,
  type ChatRuntime,
  type ChatSendMessageOptions,
  type ChatUserMessageInput,
} from "@/features/chat/chat-runtime";
import {
  invalidateCreatedDocumentQueries,
  promoteCreateDocumentDraftInspectorTab,
  resetFailedCreateDocumentDraftInspectorTab,
  resolveBoundCreateDocumentDraftChatThreadId,
  setCreateDocumentDraftInspectorTabStatus,
} from "@/features/chat/hooks/use-chat-session-created-document.logic";
import { reconcileDocumentDeletionToolCalls } from "@/features/chat/hooks/use-chat-session-document-deletion.logic";
import {
  createInitialSendQueueState,
  describeQueuedMessage,
  reduceSendQueue,
  snapshotChatRequestOptions,
  type QueuedChatEntry,
  type SendQueueEvent,
  type SendQueueState,
} from "@/features/chat/hooks/use-chat-session-send-queue.logic";
import { fetchOlderMessages } from "@/features/chat/queries";
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
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import {
  APIError,
  internalToolErrorMessage,
  toAPIError,
} from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { fileOptions } from "@/lib/files/queries";
import { sha256Hex } from "@/lib/files/sha256";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import { readStoredJson, writeStoredJson } from "@/lib/stored-json";
import { downloadFile } from "@/lib/utils";
import {
  workspacesKeys,
  workspacesNavigationOptions,
} from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";

type CreateDocumentInput = ChatUITools["create-document"]["input"];
type CreateDocumentOutput = ChatUITools["create-document"]["output"];
type CreateDocumentSuccess = Extract<CreateDocumentOutput, { success: true }>;
type CreateDocumentMatterSuccess = Extract<
  CreateDocumentSuccess,
  { entityId: string }
>;

type UseChatSessionOptions = {
  chat: ChatRuntime;
  conversationId: string;
  getDocxEditRepresentation?:
    | (() => DocxEditRepresentation | undefined)
    | undefined;
  getEditApplyMode?: (() => ChatEditApplyMode) | undefined;
  getContextMatterIds?: (() => readonly string[]) | undefined;
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
const EMPTY_CONTEXT_MATTER_IDS: readonly string[] = [];

type PreparedCreateDocumentDraft = {
  buffer: ArrayBuffer;
  fileName: string;
};

type OpenCreateDocumentDraftOptions = {
  draft: CreateDocumentDraft;
  mode: "automatic" | "explicit";
};

const prepareCreateDocumentDraft = async (
  toolCallId: string,
  input: CreateDocumentInput,
): Promise<PreparedCreateDocumentDraft | null> => {
  const fileName = buildCreateDocumentDownloadFileName(input.name);
  const prepared = await prepareCreateDocumentDraftBuffer({
    toolCallId,
    compileFallback: async () => {
      const { compileCreateDocumentSourceToDocx } =
        await import("@/components/chat/create-document-compiler");
      const compiled = await compileCreateDocumentSourceToDocx(input.source, {
        titleFallback: input.name,
      });
      return compiled.status === "ok" ? compiled.buffer : null;
    },
  });
  switch (prepared.status) {
    case "failed":
      getAnalytics().captureError(prepared.error);
      return null;
    case "ready":
      return { buffer: prepared.buffer, fileName };
    case "unavailable":
      return null;
    default:
      return prepared satisfies never;
  }
};

const openCreatedDocumentInInspector = async (
  output: CreateDocumentMatterSuccess,
) => {
  await openEntityInInspector(
    output.entityId,
    output.fileName,
    output.workspaceId,
  );
  const tab = useInspectorTabsStore
    .getState()
    .tabs.find(
      (candidate) =>
        candidate.type === "pdf" && candidate.entityId === output.entityId,
    );
  if (tab) {
    useInspectorCommandStore.getState().requestDocxEdit(tab.id);
  }
};

// `QueuedChatMessage` is the view-facing shape of a queued entry; the
// canonical definition (plus `QueuedChatEntry` and the send-queue
// reducer) lives in the sibling `.logic.ts` file. Re-exported here so
// existing consumers keep importing it from this hook.
export type { QueuedChatMessage } from "@/features/chat/hooks/use-chat-session-send-queue.logic";

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
  getContextMatterIds,
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
  const {
    error: runtimeError,
    sessionGenerating,
    status,
    turnAbandoned,
  } = snapshot;
  const notifyError = useLatestCallback((nextError: Error) => {
    onError?.(nextError);
  });
  // Latch for the error-transition effect below: `undefined` means "no
  // error has been notified yet" for the current error-free stretch.
  const lastHandledErrorRef = useRef<Error | undefined>(undefined);
  const messages = useMemo(
    () => projectCanonicalChatUIMessages(snapshot.messages),
    [snapshot.messages],
  );
  const authoritativeTurnError = useMemo(
    () => getChatAssistantTurnError(messages.at(-1) ?? null),
    [messages],
  );
  const error = runtimeError ?? authoritativeTurnError;
  const openedCreateDocumentDraftIdsRef = useRef(new Set<string>());
  const openCreateDocumentDraft = useCallback(
    ({ draft, mode }: OpenCreateDocumentDraftOptions) => {
      const inspector = useInspectorTabsStore.getState();
      const id = createDocumentDraftTabId(draft.toolCallId);
      const label = draft.name
        ? buildCreateDocumentDownloadFileName(draft.name)
        : t("chat.createDocument.headerStreaming");
      const existing = inspector.tabs.find((tab) => tab.id === id);
      const basePayload = buildCreateDocumentDraftPayload({
        draft,
        existingPayload:
          existing?.type === "view" &&
          existing.viewType === CREATE_DOCUMENT_DRAFT_VIEW
            ? existing.payload
            : undefined,
        originChatThreadId: threadRef.threadId,
        ...(threadRef.scope === "workspace"
          ? { workspaceId: threadRef.workspaceId }
          : {}),
      });
      const persistence = getCreateDocumentDraftPersistence(draft.toolCallId);
      const payload =
        persistence.status === "saving"
          ? setCreateDocumentDraftPayloadStatus({
              payload: basePayload,
              status: "saving",
            })
          : basePayload;
      for (const tab of inspector.tabs) {
        if (
          tab.id !== id &&
          tab.type === "view" &&
          tab.viewType === CREATE_DOCUMENT_DRAFT_VIEW &&
          isCreateDocumentDraftPayload(tab.payload) &&
          tab.payload.originChatThreadId === threadRef.threadId
        ) {
          inspector.closeTab(tab.id);
        }
      }
      if (mode === "explicit") {
        openedCreateDocumentDraftIdsRef.current.add(id);
        inspector.openView({
          type: CREATE_DOCUMENT_DRAFT_VIEW,
          id,
          label,
          payload,
        });
        return;
      }
      if (existing !== undefined) {
        if (
          existing.type === "view" &&
          existing.viewType === CREATE_DOCUMENT_DRAFT_VIEW &&
          existing.label === label &&
          isSameCreateDocumentDraftPayload(existing.payload, payload)
        ) {
          return;
        }
        inspector.updateView({ id, label, payload });
        return;
      }
      if (openedCreateDocumentDraftIdsRef.current.has(id)) {
        return;
      }
      openedCreateDocumentDraftIdsRef.current.add(id);
      inspector.openView({
        type: CREATE_DOCUMENT_DRAFT_VIEW,
        id,
        label,
        payload,
      });
    },
    [t, threadRef],
  );
  useExternalSyncEffect(() => {
    const draft = selectCreateDocumentDrafts(messages).at(-1);
    if (draft === undefined) {
      return;
    }
    openCreateDocumentDraft({ draft, mode: "automatic" });
  }, [messages, openCreateDocumentDraft]);
  useExternalSyncEffect(() => {
    const failedDraftIds = new Set(
      selectTerminalCreateDocumentDraftIds(messages),
    );
    if (failedDraftIds.size === 0) {
      return;
    }
    const inspector = useInspectorTabsStore.getState();
    for (const tab of inspector.tabs) {
      if (
        tab.type !== "view" ||
        tab.viewType !== CREATE_DOCUMENT_DRAFT_VIEW ||
        !isCreateDocumentDraftPayload(tab.payload) ||
        tab.payload.originChatThreadId !== threadRef.threadId ||
        !failedDraftIds.has(tab.payload.toolCallId)
      ) {
        continue;
      }
      inspector.closeTab(tab.id);
    }
  }, [messages, threadRef.threadId]);
  const handleOpenCreateDocumentDraft = useCallback(
    (toolCallId: string) => {
      const draft = selectCreateDocumentDrafts(messages).find(
        (candidate) => candidate.toolCallId === toolCallId,
      );
      if (draft !== undefined) {
        openCreateDocumentDraft({ draft, mode: "explicit" });
      }
    },
    [messages, openCreateDocumentDraft],
  );
  const settlingCreateDocumentDraftIdsRef = useRef(new Set<string>());
  const addToolResult = chat.addToolResult;
  useExternalSyncEffect(() => {
    // TanStack can accept a client tool result while the parent stream is
    // active without issuing its continuation after that stream settles.
    // Wait for the runtime's status transition so the result and resume stay
    // one atomic client operation.
    for (const draft of selectSettleableCreateDocumentDrafts(
      messages,
      status,
    )) {
      if (
        settlingCreateDocumentDraftIdsRef.current.has(draft.toolCallId) ||
        !draft.source.trim()
      ) {
        continue;
      }
      settlingCreateDocumentDraftIdsRef.current.add(draft.toolCallId);
      detached(
        (async () => {
          const settleResult = await settleCreateDocumentDraftWithRetry({
            isActive: () =>
              isCreateDocumentDraftSettlementActive(
                chat.getSnapshot().messages,
                draft.toolCallId,
              ),
            settle: async () => {
              const { compileCreateDocumentSourceToDocument } =
                await import("@/components/chat/create-document-compiler");
              const compiled = compileCreateDocumentSourceToDocument(
                draft.source,
                { titleFallback: draft.name || "Draft" },
              );
              // The compiler's report travels with the result so the model
              // can check what it produced (see the tool's RESULT REPORT
              // guidance); the user-facing failure copy stays in `message`.
              const output: CreateDocumentOutput =
                compiled.status === "ok"
                  ? {
                      success: true,
                      destination: "draft",
                      fileName: buildCreateDocumentDownloadFileName(draft.name),
                      fixes: compiled.fixes,
                      warnings: compiled.warnings,
                    }
                  : {
                      success: false,
                      message: t("chat.createDocument.failedHeader"),
                      errors: compiled.errors,
                    };
              await addToolResult({
                tool: "create-document",
                toolCallId: draft.toolCallId,
                output,
              });
            },
            wait: async () => {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 250);
              });
            },
          });
          if (settleResult.status === "failed") {
            settlingCreateDocumentDraftIdsRef.current.delete(draft.toolCallId);
            getAnalytics().captureError(settleResult.error);
            chat.setMessages(
              terminalizeUnsettledCreateDocumentDraft(
                chat.getSnapshot().messages,
                draft.toolCallId,
              ),
            );
            stellaToast.add({
              title: t("chat.createDocument.failedHeader"),
              type: "error",
            });
          }
        })(),
        "use-chat-session.settle-create-document-draft-with-retry",
      );
    }
  }, [addToolResult, chat, messages, status, t]);
  const sendChatMessage = useCallback(
    async (message: ChatUserMessageInput, options?: ChatSendMessageOptions) => {
      await sendThreadChatMessage(chat, message, options);
    },
    [chat],
  );
  const setMessages = chat.setMessages;
  const stop = chat.stop;
  const resolveToolApproval = chat.resolveToolApproval;

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
      await resolveToolApproval({ id, approved: true }, options);
    },
    [resolveToolApproval],
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
      await resolveToolApproval({ id, approved: true });
    },
    [resolveToolApproval, conversationApprovedTools, conversationId],
  );
  const handleAlwaysAllow = useCallback(
    async (id: string, toolName: ApprovalToolName) => {
      const approvalKey = getAlwaysApprovalKey({
        mcpConnectorIdentities,
        organizationId,
        toolName,
      });
      if (approvalKey === null) {
        await resolveToolApproval({ id, approved: true });
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
      await resolveToolApproval({ id, approved: true });
    },
    [
      resolveToolApproval,
      alwaysApprovedTools,
      mcpConnectorIdentities,
      organizationId,
    ],
  );
  const handleDeny = useCallback(
    async (id: string) => {
      await resolveToolApproval({ id, approved: false });
    },
    [resolveToolApproval],
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
  const handledDocumentDeletionToolCallIdsRef = useRef(new Set<string>());
  const handledDocxReplacementToolCallIdsRef = useRef(new Set<string>());

  // Chat registry writes run outside the workspace route's HTTP mutation, so
  // they cannot directly name the deleted entity in this browser: tool inputs
  // contain opaque chat refs by design. Reconcile affected workspace caches
  // and open file tabs once per completed deletion tool call.
  useExternalSyncEffect(() => {
    const contextMatterIds =
      getContextMatterIds === undefined
        ? EMPTY_CONTEXT_MATTER_IDS
        : getContextMatterIds();
    detached(
      reconcileDocumentDeletionToolCalls({
        entityKeys: entitiesKeys,
        contextMatterIds,
        handledToolCallIds: handledDocumentDeletionToolCallIdsRef.current,
        messages,
        queryClient,
        tabs: useInspectorTabsStore.getState().tabs,
        workspaceKeys: workspacesKeys,
        workspaceId,
      }),
      "use-chat-session.reconcile-document-deletion-tool-calls",
    );
  }, [getContextMatterIds, messages, queryClient, workspaceId]);

  // Server-side automatic DOCX edits (the apply variant of `suggest_changes`)
  // replace the entity's file field. Follow that replacement immediately in
  // the inspector and refresh entity-backed routes; otherwise an open tab
  // keeps addressing the stale field until a later navigation. The backend
  // moves the file-chat mapping in the same transaction, so resolving the new
  // field id preserves this conversation.
  useExternalSyncEffect(() => {
    let shouldInvalidateEntities = false;

    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }
      for (const part of message.parts) {
        if (
          part.type !== "tool-call" ||
          part.name !== SUGGEST_CHANGES_TOOL_NAME ||
          part.state !== "complete" ||
          part.output === undefined ||
          !isSuggestChangesApplyOutput(part.output) ||
          !part.output.success ||
          handledDocxReplacementToolCallIdsRef.current.has(part.id)
        ) {
          continue;
        }

        handledDocxReplacementToolCallIdsRef.current.add(part.id);
        useInspectorTabsStore
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
        "use-chat-session.invalidate",
      );
    }
  }, [messages, queryClient, workspaceId]);

  const handleCreateDocumentResolve = useCallback(
    async (
      toolCallId: string,
      destination: CreateDocumentDestination,
      input: CreateDocumentInput,
    ) => {
      if (destination.type === "download") {
        const downloadResult = await Result.tryPromise(async () => {
          const draft = await prepareCreateDocumentDraft(toolCallId, input);
          if (draft === null) {
            return { status: "invalid-source" } as const;
          }
          downloadFile(
            new Blob([new Uint8Array(draft.buffer)], { type: DOCX_MIME }),
            draft.fileName,
          );
          return { status: "downloaded", fileName: draft.fileName } as const;
        });

        if (
          Result.isError(downloadResult) ||
          downloadResult.value.status === "invalid-source"
        ) {
          if (Result.isError(downloadResult)) {
            getAnalytics().captureError(downloadResult.error);
          }
          stellaToast.add({
            title: t("chat.createDocument.failedHeader"),
            type: "error",
          });
          return;
        }
        return;
      }

      const matterId = destination.matterId;
      const draftMessageId = findReadyCreateDocumentDraftMessageId(
        chat.getSnapshot().messages,
        toolCallId,
      );
      if (draftMessageId === null) {
        return;
      }
      // Saving serializes the draft without its suggested-mode changes, and
      // the persisted inspector view is read-only, so unresolved proposals
      // would vanish. Keep the draft review session alive until the user
      // resolves it.
      const hasPendingDraftReview =
        useReviewStore
          .getState()
          .sessions[createDocumentDraftReviewId(toolCallId)]?.some(
            (item) => item.status === "pending" || item.status === "applying",
          ) === true;
      if (hasPendingDraftReview) {
        stellaToast.add({
          title: t("chat.createDocument.savePendingReview"),
          type: "warning",
        });
        return;
      }
      const inspector = useInspectorTabsStore.getState();
      const boundChatThreadId = resolveBoundCreateDocumentDraftChatThreadId({
        inspector,
        retainedChatThreadId:
          getBoundCreateDocumentDraftChatThreadId(toolCallId),
        toolCallId,
      });
      const persistence = beginCreateDocumentDraftPersistence({
        boundChatThreadId,
        toolCallId,
      });
      if (persistence.status !== "saving") {
        return;
      }
      setCreateDocumentDraftInspectorTabStatus({
        inspector,
        status: "saving",
        toolCallId,
      });
      const draftChatThreadId = persistence.boundChatThreadId;
      const createResult = await Result.tryPromise(async () => {
        const draft = await prepareCreateDocumentDraft(toolCallId, input);
        if (draft === null) {
          throw new ClientOperationError({
            action: "prepare-create-document-draft",
            message: "Generated document source could not be compiled",
          });
        }
        const properties = await queryClient.query(propertiesOptions(matterId));
        const fileProperty = properties.find(
          (property) => property.content.type === "file",
        );
        if (fileProperty === undefined) {
          throw new ClientOperationError({
            action: "save-create-document-draft",
            message: "Destination matter has no file property",
          });
        }

        const file = new File([new Uint8Array(draft.buffer)], draft.fileName, {
          type: DOCX_MIME,
        });
        const contentSha256Hex = await sha256Hex(draft.buffer);
        const response = await api
          .entities({ workspaceId: toSafeId<"workspace">(matterId) })
          ["upload-generated-document"].post({
            file,
            contentSha256Hex,
            messageId: toSafeId<"chatMessage">(draftMessageId),
            name: draft.fileName,
            propertyId: fileProperty.id,
            ...(draftChatThreadId === null
              ? {}
              : {
                  draftChatThreadId: toSafeId<"chatThread">(draftChatThreadId),
                }),
            threadId: toSafeId<"chatThread">(threadRef.threadId),
            ...(threadRef.scope === "workspace"
              ? {
                  threadWorkspaceId: toSafeId<"workspace">(
                    threadRef.workspaceId,
                  ),
                }
              : {}),
            toolCallId,
          });
        if (response.error) {
          throw toAPIError(response.error);
        }
        const created = response.data;
        const fileName = created.fileName;
        const href = toChatResourceHref({
          type: RESOURCE_TYPE.ENTITY,
          resource: resourceRef({
            type: RESOURCE_TYPE.ENTITY,
            id: toSafeId<"entity">(created.entityId),
          }),
          location: {
            type: "workspace",
            workspace: resourceRef({
              type: RESOURCE_TYPE.WORKSPACE,
              id: toSafeId<"workspace">(matterId),
            }),
          },
        });
        return {
          success: true,
          fileName,
          entityId: created.entityId,
          fieldId: created.fieldId,
          workspaceId: matterId,
          entityRef: created.entityId,
          matterRef: matterId,
          href,
          mention: `[${fileName}](${href})`,
        } satisfies CreateDocumentMatterSuccess;
      });

      if (Result.isError(createResult)) {
        endCreateDocumentDraftPersistence(toolCallId);
        resetFailedCreateDocumentDraftInspectorTab({
          getInspector: useInspectorTabsStore.getState,
          toolCallId,
        });
        getAnalytics().captureError(createResult.error);
        stellaToast.add({
          title: APIError.is(createResult.error)
            ? internalToolErrorMessage(createResult.error)
            : t("chat.createDocument.failedHeader"),
          type: "error",
        });
        return;
      }
      const output = createResult.value;

      setMessages(
        replaceReadyCreateDocumentDraftOutput(
          chat.getSnapshot().messages,
          toolCallId,
          output,
        ),
      );

      const promotedDraftInPlace = promoteCreateDocumentDraftInspectorTab({
        entityId: output.entityId,
        fieldId: output.fieldId,
        fileName: output.fileName,
        getInspector: useInspectorTabsStore.getState,
        persistence,
        toolCallId,
        workspaceId: output.workspaceId,
      });
      completeCreateDocumentDraft(toolCallId);

      await invalidateCreatedDocumentQueries({
        queryClient,
        queryKeys: [
          entitiesKeys.all(matterId),
          workspacesKeys.activityAll(matterId),
          workspacesKeys.overviewActivityAll(matterId),
        ],
      });

      // Prime the file-bytes cache the moment the server returns —
      // there's typically a multi-second gap before the user clicks
      // "Open in editor", and the docx editor's biggest mount cost
      // is the presigned URL roundtrip + S3 download. We kick this
      // off as a fire-and-forget; failures are silent because the
      // editor will retry the same query on mount.
      detached(
        queryClient.query(
          fileOptions({
            workspaceId: matterId,
            fieldId: output.fieldId,
            purpose: "native-display",
          }),
        ),
        "use-chat-session.prefetch",
      );

      if (!promotedDraftInPlace) {
        await openCreatedDocumentInInspector(output);
      }
    },
    [chat, queryClient, setMessages, t, threadRef],
  );

  const handleOpenCreatedDocument = useCallback(
    async (output: CreateDocumentMatterSuccess) => {
      await openCreatedDocumentInInspector(output);
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
    (isChatClientRequestActive(status) ||
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
    if (!runtimeError) {
      lastHandledErrorRef.current = undefined;
      return;
    }
    if (lastHandledErrorRef.current === runtimeError) {
      return;
    }
    lastHandledErrorRef.current = runtimeError;
    notifyError(runtimeError);
  }, [notifyError, runtimeError]);

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
      "use-chat-session.dispatch-queued-message",
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
    turnAbandoned,
    alwaysApprovedTools,
    conversationApprovedTools,
    handleApprove,
    handleAllowInConversation,
    handleDeny,
    handleAskUserSubmit,
    handleAskUserEditAndRerun,
    handleAlwaysAllow,
    handleCreateDocumentResolve,
    handleOpenCreateDocumentDraft,
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
