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
import { useRouter } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type { ChatSendMode } from "@stll/anonymize-chat";
import { CHAT_MESSAGE_EDIT_ERROR_CODE } from "@stll/api-contract";
import type {
  ConnectConnectorDecision,
  ConnectConnectorOutput,
} from "@stll/api-contract/chat-connector";
import { buildCreateDocumentDownloadFileName } from "@stll/api-contract/chat-create-document";
import { requiresPerCallChatApproval } from "@stll/api-contract/chat-secret";
import type { RequestSecretOutput } from "@stll/api-contract/chat-secret";
import {
  CHAT_MEMBER_SEND_ACTION,
  CHAT_SEND_INTENT,
  CHAT_TURN_STEERING,
  type ChatMemberSendAction,
  chatSendIntent,
  type ChatThreadSendState,
  type ChatTurnSteering,
} from "@stll/api-contract/chat-send-intent";
import type { ChatToolGrantScope } from "@stll/api-contract/chat-tool-grants";
import { sleep } from "@stll/concurrency/sleep";
import type { HandlerExceptionScope } from "@stll/errors";
import { sha256Hex } from "@stll/sha256/browser";
import { stellaToast } from "@stll/ui/toast";
import { useIsMobile } from "@stll/ui/use-mobile";

import { createDocumentDraftReviewId } from "@/components/ai-suggestions/file-review-session";
import { useReviewStore } from "@/components/ai-suggestions/review-store";
import {
  CHAT_SEND_KEPT,
  CHAT_SEND_SENT,
  type ChatSendOutcome,
  useOptionalChatEditorManager,
} from "@/components/chat-editor-provider";
import { AnonymizedSpan } from "@/components/chat/anonymized-span";
import type {
  RequestSecretDecision,
  SecretTargetResolution,
} from "@/components/chat/chat-approval-context";
import type { ChatTableChartProps } from "@/components/chat/chat-table-chart";
import type {
  ApprovalToolName,
  AskUserOutput,
  ChatUITools,
  PersistedChatMessage,
  PlaybookSaveTarget,
} from "@/components/chat/chat-ui-tools";
import {
  consumePlaybookSaveToolCalls,
  getAwaitedAssistantMessageId,
  getChatAssistantTurnError,
  getChatWorkAwaitedAtOpen,
  getCurrentApprovalPendingMessageId,
  isChatClientRequestActive,
  isNonPersistentGrantChatToolName,
  isSuggestChangesApplyOutput,
  openHarnessApprovalRequestIds,
  openMemberWaitKeys,
  projectCanonicalChatUIMessages,
  sanitizeRunningToolCalls,
  SUGGEST_CHANGES_TOOL_NAME,
} from "@/components/chat/chat-ui-tools";
import { isChatTurnGenerating } from "@/components/chat/chat-user-actions";
import {
  beginCreateDocumentDraftPersistence,
  completeCreateDocumentDraft,
  endCreateDocumentDraftPersistence,
  getBoundCreateDocumentDraftChatThreadId,
  getCreateDocumentDraftPersistence,
  prepareCreateDocumentDraft as prepareCreateDocumentDraftBuffer,
  settleCreateDocumentDraftWithRetry,
} from "@/components/chat/create-document-draft-runtime";
import {
  buildCreateDocumentDraftPayload,
  CREATE_DOCUMENT_DRAFT_VIEW,
  type CreateDocumentDraft,
  createDocumentDraftTabId,
  findReadyCreateDocumentDraftMessageId,
  isCreateDocumentDraftPayload,
  isCreateDocumentDraftSettlementActive,
  isSameCreateDocumentDraftPayload,
  replaceReadyCreateDocumentDraftOutput,
  selectCreateDocumentDrafts,
  selectSettleableCreateDocumentDrafts,
  selectTerminalCreateDocumentDraftIds,
  setCreateDocumentDraftPayloadStatus,
  terminalizeUnsettledCreateDocumentDraft,
} from "@/components/chat/create-document-draft.logic";
import { openEntityInInspector } from "@/components/chat/entity-open";
import type { CreateDocumentDestination } from "@/components/chat/needs-matter-card";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { buildEditedUserMessage } from "@/components/chat/user-message-edit.logic";
import type {
  UserMessageEdit,
  UserMessageEditOutcome,
} from "@/components/chat/user-message-edit.logic";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { queryView } from "@/lib/query-view.logic";
import "@/components/chat/create-document-draft-inspector";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { entityReferenceHref } from "@/components/references/reference.logic";
import { chatKeys } from "@/features/chat/chat-query-contract";
import {
  type ChatQueue,
  chatQueueOptions,
  type ChatQueueView,
  enqueueChatMessage,
  moveQueuedChatMessage,
  pauseChatQueue,
  removeQueuedChatMessage,
  resumeChatQueue,
  sendQueuedChatMessageNow,
  updateCachedChatQueue,
} from "@/features/chat/chat-queue";
import {
  canQueueMessage,
  composerDraftOfParts,
  isQueueInsteadRefusal,
  messagePartsOf,
  queuedSendNow,
  queueMoveTarget,
  snapshotChatRequestOptions,
  steerableMessageText,
  withQueuedMessageMoved,
  withQueuedMessageRemoved,
} from "@/features/chat/chat-queue.logic";
import {
  type ChatRuntime,
  type ChatSendMessageOptions,
  type ChatUserMessageInput,
  queuedChatSendOf,
  sendThreadChatMessageUntilAccepted,
} from "@/features/chat/chat-runtime";
import {
  resendLatestChatMessage,
  showStoredChatThread,
} from "@/features/chat/chat-runtime-registry";
import {
  chatToolGrantsOptions,
  projectChatToolGrants,
  readChatToolGrantCoverage,
  storeChatToolGrant,
} from "@/features/chat/chat-tool-grants";
import { LazyChatTableChart } from "@/features/chat/components/lazy-chat-table-chart";
import {
  planTruncatedReplay,
  userMessageEditFailure,
} from "@/features/chat/hooks/edit-user-message";
import type { TruncatedReplayTarget } from "@/features/chat/hooks/edit-user-message";
import {
  invalidateCreatedDocumentQueries,
  promoteCreateDocumentDraftInspectorTab,
  resetFailedCreateDocumentDraftInspectorTab,
  resolveBoundCreateDocumentDraftChatThreadId,
  setCreateDocumentDraftInspectorTabStatus,
} from "@/features/chat/hooks/use-chat-session-created-document.logic";
import { reconcileDocumentDeletionToolCalls } from "@/features/chat/hooks/use-chat-session-document-deletion.logic";
import {
  followReconciledPlaybookSave,
  playbookPaneReaction,
  playbookPaneState,
  reconcilePlaybookSaveToolCalls,
} from "@/features/chat/hooks/use-chat-session-playbook-save.logic";
import type { PlaybookPaneMode } from "@/features/chat/hooks/use-chat-session-playbook-save.logic";
import { reconcileReaderAnnotationWriteToolCalls } from "@/features/chat/hooks/use-chat-session-reader-annotation-write.logic";
import {
  fetchChatMessage,
  fetchOlderMessages,
  invalidateChatThreadAcrossScopes,
} from "@/features/chat/queries";
import { getChatTurnPhase } from "@/features/chat/turn-notifications.logic";
import { useChatTurnNotifications } from "@/features/chat/use-chat-turn-notifications";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import type { ChatTimingSurface } from "@/lib/analytics/types";
import { api, chatConnectorReceipt } from "@/lib/api";
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
  unwrapApiResponse,
} from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { notifyUserError } from "@/lib/errors/user-toast";
import { fileOptions } from "@/lib/files/queries";
import {
  isPlaybookDraftViewPayload,
  PLAYBOOK_DRAFT_VIEW,
  playbookDraftTabId,
} from "@/lib/knowledge/playbook-draft-view";
import { knowledgeKeys, playbookDetailOptions } from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";
import { downloadFile } from "@/lib/utils";
import { createUuid } from "@/lib/uuid";
import {
  workspacesKeys,
  workspacesNavigationOptions,
} from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import {
  type CurrentWorkspaceDocument,
  getCurrentWorkspaceDocument,
} from "@/lib/workspaces/use-workspace-view-params";

type CreateDocumentInput = ChatUITools["create-document"]["input"];
type CreateDocumentOutput = ChatUITools["create-document"]["output"];
type CreateDocumentSuccess = Extract<CreateDocumentOutput, { success: true }>;
type CreateDocumentMatterSuccess = Extract<
  CreateDocumentSuccess,
  { entityId: string }
>;

type UseChatSessionOptions = {
  exceptionScope: HandlerExceptionScope;
  chat: ChatRuntime;
  conversationId: string;
  getDocxEditRepresentation?:
    (() => DocxEditRepresentation | undefined) | undefined;
  getEditApplyMode?: (() => ChatEditApplyMode) | undefined;
  getContextMatterIds?: (() => readonly string[]) | undefined;
  getSendMode?: (() => ChatSendMode) | undefined;
  /**
   * Whether the thread's turns take a message mid-turn (`chatTurnSteering`);
   * a surface without it has turns that never do, so its sends queue.
   */
  getTurnSteering?: (() => ChatTurnSteering) | undefined;
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
  /** Whether a playbook this thread saves opens beside it by itself. */
  playbookPane: PlaybookPaneMode;
  threadRef: ChatThreadRef;
  /** Where the conversation is shown; every send is timed under it. */
  timingSurface: ChatTimingSurface;
  workspaceId?: string | undefined;
};

export type ResendLatestMessageOptions = {
  messageId?: string | undefined;
  sendMode?: ChatSendMode | undefined;
};

const EMPTY_CONTEXT_MATTER_IDS: readonly string[] = [];

type PreparedCreateDocumentDraft = {
  buffer: ArrayBuffer;
  fileName: string;
};

type OpenCreateDocumentDraftOptions = {
  draft: CreateDocumentDraft;
  mode: "automatic" | "explicit";
};

type FollowPlaybookSaveOptions = {
  saved: PlaybookSaveTarget;
  /** The thread pane that was current when the save was reconciled. */
  paneTabId: string;
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
      getAnalytics().captureError(prepared.error, {
        fingerprintKey: "prepareCreateDocumentDraft:failure",
        scope: {
          type: "handler",
          handlerId: "prepareCreateDocumentDraft:failure",
        },
      });
      return null;
    case "ready":
      return { buffer: prepared.buffer, fileName };
    case "unavailable":
      return null;
    default:
      prepared satisfies never;
      return panic(`Unhandled prepared: ${String(prepared)}`);
  }
};

const downloadCreateDocumentDraft = async (
  toolCallId: string,
  input: CreateDocumentInput,
) =>
  Result.tryPromise(async () => {
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

const openCreatedDocumentInInspector = async (
  output: CreateDocumentMatterSuccess,
  documentOnScreen: CurrentWorkspaceDocument,
) => {
  await openEntityInInspector({
    documentOnScreen,
    entityId: output.entityId,
    label: output.fileName,
    workspaceId: output.workspaceId,
  });
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

const EMPTY_CHAT_QUEUE: ChatQueue = { hold: null, items: [] };

export const useChatSession = ({
  exceptionScope: { handlerId: exceptionHandlerId },
  chat,
  conversationId,
  getDocxEditRepresentation,
  getContextMatterIds,
  getEditApplyMode,
  getSendMode,
  getTurnSteering,
  initialOlderCursor,
  onError,
  playbookPane,
  threadRef,
  timingSurface,
  workspaceId,
}: UseChatSessionOptions) => {
  const t = useTranslations();
  const { activeOrganizationId: organizationId, id: userId } =
    useAuthenticatedUser();
  const queryClient = useQueryClient();
  const router = useRouter();
  const chatToolGrantsQuery = useQuery(
    chatToolGrantsOptions({
      activeOrganizationId: organizationId,
      threadId: conversationId,
      userId,
    }),
  );
  const chatToolGrantsView = queryView(chatToolGrantsQuery);
  useQueryViewError(chatToolGrantsView, "useChatSession:query");
  const storedChatToolGrants =
    chatToolGrantsView.type === "items"
      ? chatToolGrantsView.items.grants
      : undefined;
  const {
    always: alwaysApprovedTools,
    conversation: conversationApprovedTools,
  } = useMemo(
    () => projectChatToolGrants(storedChatToolGrants),
    [storedChatToolGrants],
  );

  const snapshot = useSyncExternalStore(
    chat.subscribe,
    chat.getSnapshot,
    chat.getSnapshot,
  );
  // What the thread already waits on when this page opens it: it resumes only
  // once the user acts. Read per page open, not per runtime, because the
  // registry keeps a waiting thread's runtime across a reopen.
  const workAwaitedAtOpen = useMemo(
    () => getChatWorkAwaitedAtOpen(chat.getSnapshot().messages),
    [chat],
  );
  const {
    error: runtimeError,
    isLoading: clientLoading,
    sessionGenerating,
    reconnecting,
    status,
    stop: stopState,
    turnAbandoned,
    computerWait,
    turnSentAt,
    turnsStarted,
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
              await sleep(250);
            },
          });
          if (settleResult.status === "failed") {
            settlingCreateDocumentDraftIdsRef.current.delete(draft.toolCallId);
            getAnalytics().captureError(settleResult.error, {
              fingerprintKey: "useChatSession:failure",
              scope: { type: "handler", handlerId: exceptionHandlerId },
            });
            chat.setMessages(
              terminalizeUnsettledCreateDocumentDraft(
                chat.getSnapshot().messages,
                draft.toolCallId,
              ),
            );
            notifyUserError(
              settleResult.error,
              t("chat.createDocument.failedHeader"),
            );
          }
        })(),
        "use-chat-session.settle-create-document-draft-with-retry",
      );
    }
  }, [addToolResult, chat, messages, status, t, exceptionHandlerId]);
  const setMessages = chat.setMessages;
  const stop = chat.stop;
  const leave = chat.leave;
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
  const historicalPlaybookSaveToolCallIdsRef = useRef(new Set<string>());
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
    // oxlint-disable-next-line react/refs -- deliberate render-time ref write: mirrors the re-seed synchronously so an older-page response resolving in the commit→effect window is discarded by the stale-response guard
    olderCursorRef.current = initialOlderCursor;
    // oxlint-disable-next-line react/refs -- deliberate render-time ref write: see above, closes the commit→effect race window for the stale-response guard
    isLoadingOlderRef.current = false;
    // oxlint-disable-next-line react/refs -- deliberate render-time ref write: render-current runtime identity for the stale-response guard in loadOlder
    seededChatRef.current = chat;
  }

  const refreshAnswers = useCallback(
    async (messageId: string) => {
      const runtime = chat;
      const [refreshed] = await Promise.all([
        fetchChatMessage({ threadId: threadRef.threadId, messageId }),
        invalidateChatThreadAcrossScopes({
          queryClient,
          threadId: threadRef.threadId,
        }),
      ]);
      if (seededChatRef.current === runtime) {
        runtime.setMessages(
          runtime
            .getSnapshot()
            .messages.map((message) =>
              message.id === refreshed.id &&
              (message.revision === undefined ||
                message.revision <= refreshed.revision)
                ? refreshed
                : message,
            ),
        );
      }
    },
    [chat, queryClient, threadRef],
  );

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
      getAnalytics().captureError(result.error, {
        fingerprintKey: "useChatSession:failure-2",
        scope: { type: "handler", handlerId: exceptionHandlerId },
      });
      setLoadOlderError(true);
      notifyUserError(result.error, t("chat.loadEarlierMessagesError"));
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
      // Record provenance before publishing the page to the live runtime.
      // Reconciliation still refreshes caches for these saves.
      consumePlaybookSaveToolCalls({
        handledToolCallIds: historicalPlaybookSaveToolCallIdsRef.current,
        messages: prepend,
      });
      setMessages([...prepend, ...current]);
    }
    olderCursorRef.current = older.olderCursor;
    setOlderCursor(older.olderCursor);
  }, [chat, setMessages, t, threadRef, exceptionHandlerId]);

  // The chat's queue is the server's: it sends the first message as the
  // member once the turn has ended and nothing holds it. Read for a thread
  // the server stores (one with messages), and again on every queue change
  // and every turn's start or end (the user stream).
  const queueThread = useMemo(
    () => ({
      activeOrganizationId: organizationId,
      threadId: threadRef.threadId,
      userId,
    }),
    [organizationId, threadRef.threadId, userId],
  );
  const chatQueueView = queryView(
    useQuery({
      ...chatQueueOptions(queueThread),
      enabled: messages.length > 0,
    }),
  );
  useQueryViewError(chatQueueView, "useChatSession:queue");
  const chatQueue: ChatQueue =
    chatQueueView.type === "items" ? chatQueueView.items : EMPTY_CHAT_QUEUE;
  /** The queue as last read, for decisions made in event handlers. */
  const readQueue = useCallback(
    (): ChatQueue =>
      queryClient.getQueryData(chatQueueOptions(queueThread).queryKey) ??
      EMPTY_CHAT_QUEUE,
    [queryClient, queueThread],
  );
  const refreshQueue = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: chatQueueOptions(queueThread).queryKey,
    });
  }, [queryClient, queueThread]);
  const draftManager = useOptionalChatEditorManager();
  /** Queued messages this page removed (or handed to a turn): their leaving
   *  the queue is no turn the server started. */
  const removedHereRef = useRef(new Set<string>());
  const removeFromQueue = useCallback(
    async (id: string) => {
      removedHereRef.current.add(id);
      return await removeQueuedChatMessage(threadRef.threadId, id);
    },
    [threadRef.threadId],
  );

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

  /** Whether a turn of the thread runs on this page now. */
  const turnRuns = useCallback((): boolean => {
    const runtime = chat.getSnapshot();
    const shown = projectCanonicalChatUIMessages(runtime.messages);
    return (
      runtime.isLoading ||
      isChatTurnGenerating({
        hasError:
          (runtime.error ?? getChatAssistantTurnError(shown.at(-1) ?? null)) !==
          undefined,
        messages: shown,
        requestActive:
          runtime.reconnecting || isChatClientRequestActive(runtime.status),
        sessionGenerating: runtime.sessionGenerating,
        stopStatus: runtime.stop.status,
      })
    );
  }, [chat]);

  /** What the thread is doing now, as the send routing reads it. */
  const threadSendState = useCallback((): ChatThreadSendState => {
    const steering = getTurnSteering?.() ?? CHAT_TURN_STEERING.notSteerable;
    // A wait is read first: a card can show while the request that brought
    // it still ends, and a steer then has to decline it to reach the turn.
    const { localRunQuestion, messages: shown } = chat.getSnapshot();
    if (
      openMemberWaitKeys({
        localRunQuestion,
        messages: projectCanonicalChatUIMessages(shown),
      }).length > 0
    ) {
      return { type: "waiting_on_member", steering };
    }
    if (turnRuns()) {
      return { type: "working", steering };
    }
    // Messages queued ahead that nothing holds go first: the server is
    // about to send them, and refuses a new one that would jump them.
    const current = readQueue();
    return current.items.length > 0 && current.hold === null
      ? { type: "working", steering: CHAT_TURN_STEERING.notSteerable }
      : { type: "idle" };
  }, [chat, getTurnSteering, readQueue, turnRuns]);

  /** Put a message the server did not take back into the composer. Falls
   *  back to a notice when this surface shows no composer of the thread. */
  const restoreIntoComposer = useCallback(
    (message: ChatUserMessageInput): boolean =>
      draftManager?.restoreMessageDraftIntoThread(
        threadRef,
        composerDraftOfParts(messagePartsOf(message)),
      ) ?? false,
    [draftManager, threadRef],
  );

  /**
   * Queue `message` at the end of the chat's queue, as it would be sent now
   * (its mode and document preferences snapshotted). `kept` when the server
   * did not take it: the composer gets it back.
   */
  const enqueueMessage = useCallback(
    async (
      message: ChatUserMessageInput,
      options?: ChatSendMessageOptions,
    ): Promise<ChatSendOutcome> => {
      if (!canQueueMessage(message)) {
        stellaToast.warning(t("chat.queue.filesNotQueued"));
        return CHAT_SEND_KEPT;
      }
      const send = queuedChatSendOf(
        chat,
        message,
        withRequestSnapshots(options),
      );
      const queued = await Result.tryPromise(
        async () => await enqueueChatMessage(threadRef.threadId, send),
      );
      if (Result.isError(queued)) {
        notifyUserError(queued.error, t("chat.sendError"));
        return CHAT_SEND_KEPT;
      }
      const { item } = queued.value;
      updateCachedChatQueue({
        queryClient,
        thread: queueThread,
        update: (current) =>
          current.items.some(({ id }) => id === item.id)
            ? current
            : { hold: current.hold, items: [...current.items, item] },
      });
      return CHAT_SEND_SENT;
    },
    [
      chat,
      queryClient,
      queueThread,
      t,
      threadRef.threadId,
      withRequestSnapshots,
    ],
  );

  /** Run a write on the queue, telling the member when it failed; the queue
   *  is read again either way. */
  const writeQueue = useCallback(
    async (write: () => Promise<unknown>): Promise<boolean> => {
      const written = await Result.tryPromise(write);
      if (Result.isError(written)) {
        notifyUserError(written.error, t("errors.actionFailed"));
      }
      await refreshQueue();
      return Result.isOk(written);
    },
    [refreshQueue, t],
  );

  /**
   * Hand `text` to the turn running on the member's computer under `id`. A
   * turn that does not take it leaves `onNotTaken` to place the message.
   */
  const steerTurn = useCallback(
    (input: { id: string; text: string }, onNotTaken: () => Promise<void>) => {
      detached(
        (async () => {
          const outcome = await chat.steerLocalTurn({
            inputId: input.id,
            text: input.text,
          });
          if (outcome !== "steered") {
            await onNotTaken();
          }
        })(),
        "use-chat-session.steer",
      );
    },
    [chat],
  );

  /**
   * The edit forms of sent messages open on this page, and whether the page
   * paused the queue for them (`holdQueueForMessageEdit`). An edit drops
   * every later turn, so a new message waits until the edit was sent or
   * cancelled.
   */
  const editPauseRef = useRef<{ paused: boolean; sessions: Set<string> }>({
    paused: false,
    sessions: new Set(),
  });

  /** A message steered into a turn waiting on the member, handed to the
   *  turn once declining the wait lets it run again; it waits queued. */
  const steerOnResumeRef = useRef<{ id: string; text: string } | null>(null);

  // Where a message goes is `chatSendIntent`'s call, by what the thread is
  // doing and whether the member sent it plainly or queued it.
  const routeMessage = useCallback(
    async (
      action: ChatMemberSendAction,
      message: ChatUserMessageInput,
      options?: ChatSendMessageOptions,
    ): Promise<ChatSendOutcome> => {
      if (editPauseRef.current.sessions.size > 0) {
        stellaToast.info(t("chat.queue.waitForEdit"));
        return CHAT_SEND_KEPT;
      }
      const state = threadSendState();
      const intent = chatSendIntent(state, action);
      switch (intent) {
        case CHAT_SEND_INTENT.steer: {
          const text = steerableMessageText(
            message,
            withRequestSnapshots(options),
          );
          if (text === null) {
            return await enqueueMessage(message, options);
          }
          if (state.type === "waiting_on_member") {
            // The shown approval is declined, explicitly, as the member's
            // own Deny would, so the turn goes on and is handed the message
            // once it runs again. A question is never dismissed for it:
            // dismissing one stops the run's turn. Either way the message
            // waits queued until then.
            const queued = await enqueueMessage(message, options);
            const approvalIds = openHarnessApprovalRequestIds(
              projectCanonicalChatUIMessages(chat.getSnapshot().messages),
            );
            if (queued.kind === "sent" && approvalIds.length > 0) {
              steerOnResumeRef.current = { id: message.id, text };
              for (const approvalId of approvalIds) {
                detached(
                  resolveToolApproval({ id: approvalId, approved: false }),
                  "use-chat-session.decline-for-steer",
                );
              }
            }
            return queued;
          }
          // The running turn takes it; one that does not keeps it queued
          // for its end, so messages go in the order they were sent.
          steerTurn({ id: message.id, text }, async () => {
            // Not queued either (the refusal was told): the composer
            // gets it back, where the thread shows one.
            if ((await enqueueMessage(message, options)).kind === "kept") {
              restoreIntoComposer(message);
            }
          });
          return CHAT_SEND_SENT;
        }
        case CHAT_SEND_INTENT.queue:
          return await enqueueMessage(message, options);
        case CHAT_SEND_INTENT.start:
          break;
        default:
          intent satisfies never;
          return panic(`Unhandled send intent: ${String(intent)}`);
      }

      const shownBefore = chat.getSnapshot().messages;
      const acceptance = await sendThreadChatMessageUntilAccepted(
        chat,
        message,
        { ...withRequestSnapshots(options), timingSurface },
      );
      if (acceptance.status === "accepted") {
        return CHAT_SEND_SENT;
      }
      // Refused: the page shows the thread as the server stores it. A message
      // the server stored (it took the turn before the request failed) stays
      // there with its turn; any other goes into the queue when a turn or the
      // queue was ahead of it, or back into the composer.
      await showStoredChatThread(chat, shownBefore);
      if (
        chat.getSnapshot().messages.some((shown) => shown.id === message.id)
      ) {
        return CHAT_SEND_SENT;
      }
      if (isQueueInsteadRefusal(acceptance.error)) {
        return await enqueueMessage(message, options);
      }
      notifyUserError(acceptance.error, t("chat.sendError"));
      return CHAT_SEND_KEPT;
    },
    [
      chat,
      enqueueMessage,
      resolveToolApproval,
      restoreIntoComposer,
      steerTurn,
      t,
      threadSendState,
      timingSurface,
      withRequestSnapshots,
    ],
  );

  const sendMessage = useCallback(
    async (
      message: ChatUserMessageInput,
      options?: ChatSendMessageOptions,
    ): Promise<ChatSendOutcome> =>
      await routeMessage(CHAT_MEMBER_SEND_ACTION.send, message, options),
    [routeMessage],
  );

  /** The member's queue action: the message waits for the turn's end
   *  wherever a turn runs or waits; on an idle thread it is sent. */
  const queueMessage = useCallback(
    async (
      message: ChatUserMessageInput,
      options?: ChatSendMessageOptions,
    ): Promise<ChatSendOutcome> =>
      await routeMessage(CHAT_MEMBER_SEND_ACTION.queue, message, options),
    [routeMessage],
  );

  /**
   * "Send now" on a queued message: a running turn on the member's computer
   * that takes a message mid-turn is handed it (and the message leaves the
   * queue); otherwise the server sends it next, stopping a turn that runs.
   * A turn that waits on the member is ended only once the member confirms
   * (`confirm`, then `replaceWithQueuedMessage`).
   */
  const sendQueuedMessageNow = useCallback(
    (id: string): "confirm" | "done" => {
      const item = readQueue().items.find((queued) => queued.id === id);
      if (item === undefined) {
        return "done";
      }
      const route = queuedSendNow(threadSendState(), item);
      switch (route.type) {
        case "steer":
          detached(
            (async () => {
              const outcome = await chat.steerLocalTurn({
                inputId: id,
                text: route.text,
              });
              await writeQueue(async () =>
                outcome === "steered"
                  ? await removeFromQueue(id)
                  : await sendQueuedChatMessageNow(threadRef.threadId, id),
              );
            })(),
            "use-chat-session.steer-queued-message",
          );
          return "done";
        case "replace":
          return "confirm";
        case "send":
          detached(
            writeQueue(
              async () =>
                await sendQueuedChatMessageNow(threadRef.threadId, id),
            ),
            "use-chat-session.send-queued-message-now",
          );
          return "done";
        default:
          route satisfies never;
          return panic("Unhandled send-now route");
      }
    },
    [
      chat,
      readQueue,
      removeFromQueue,
      threadRef.threadId,
      threadSendState,
      writeQueue,
    ],
  );

  /** The confirmed Send now over a turn waiting on the member: it ends what
   *  the turn waits on, and the message goes next. */
  const replaceWithQueuedMessage = useCallback(
    (id: string) => {
      detached(
        writeQueue(
          async () => await sendQueuedChatMessageNow(threadRef.threadId, id),
        ),
        "use-chat-session.replace-with-queued-message",
      );
    },
    [threadRef.threadId, writeQueue],
  );

  const removeQueuedMessage = useCallback(
    (id: string) => {
      updateCachedChatQueue({
        queryClient,
        thread: queueThread,
        update: (current) => withQueuedMessageRemoved({ id, queue: current }),
      });
      detached(
        writeQueue(async () => await removeFromQueue(id)),
        "use-chat-session.remove-queued-message",
      );
    },
    [queryClient, queueThread, removeFromQueue, writeQueue],
  );

  /** "Edit": the message leaves the queue and goes back into the composer,
   *  to be written again and sent or queued anew. */
  const editQueuedMessage = useCallback(
    (id: string) => {
      detached(
        (async () => {
          const removed = await Result.tryPromise(
            async () => await removeFromQueue(id),
          );
          await refreshQueue();
          if (Result.isError(removed)) {
            notifyUserError(removed.error, t("errors.actionFailed"));
            return;
          }
          const { message } = removed.value;
          if (message === null) {
            stellaToast.info(t("chat.queue.noLongerQueued"));
            return;
          }
          const draft = composerDraftOfParts(message.parts);
          if (
            draftManager?.restoreMessageDraftIntoThread(threadRef, draft) !==
            true
          ) {
            // No composer of the thread here: the message is queued again.
            await enqueueMessage(
              {
                content: draft.html,
                id: toSafeId<"chatMessage">(createUuid()),
              },
              undefined,
            );
          }
        })(),
        "use-chat-session.edit-queued-message",
      );
    },
    [draftManager, enqueueMessage, refreshQueue, removeFromQueue, t, threadRef],
  );

  const moveQueuedMessage = useCallback(
    (id: string, direction: "down" | "up") => {
      const target = queueMoveTarget({
        direction,
        id,
        items: readQueue().items,
      });
      if (target === undefined) {
        return;
      }
      updateCachedChatQueue({
        queryClient,
        thread: queueThread,
        update: (current) =>
          withQueuedMessageMoved({
            beforeId: target.beforeId,
            id,
            queue: current,
          }),
      });
      detached(
        writeQueue(
          async () =>
            await moveQueuedChatMessage({
              beforeId: target.beforeId,
              messageId: id,
              threadId: threadRef.threadId,
            }),
        ),
        "use-chat-session.move-queued-message",
      );
    },
    [queryClient, queueThread, readQueue, threadRef.threadId, writeQueue],
  );

  const pauseQueue = useCallback(() => {
    detached(
      writeQueue(async () => await pauseChatQueue(threadRef.threadId)),
      "use-chat-session.pause-queue",
    );
  }, [threadRef.threadId, writeQueue]);

  const resumeQueue = useCallback(() => {
    detached(
      writeQueue(async () => await resumeChatQueue(threadRef.threadId)),
      "use-chat-session.resume-queue",
    );
  }, [threadRef.threadId, writeQueue]);

  const queue: ChatQueueView = useMemo(
    () => ({
      actions: {
        edit: editQueuedMessage,
        move: moveQueuedMessage,
        pause: pauseQueue,
        remove: removeQueuedMessage,
        replaceWith: replaceWithQueuedMessage,
        resume: resumeQueue,
        sendNow: sendQueuedMessageNow,
      },
      hold: chatQueue.hold,
      items: chatQueue.items,
    }),
    [
      chatQueue,
      editQueuedMessage,
      moveQueuedMessage,
      pauseQueue,
      removeQueuedMessage,
      replaceWithQueuedMessage,
      resumeQueue,
      sendQueuedMessageNow,
    ],
  );

  // A turn paused on its budget runs its next step only on the user's word:
  // Continue sends that word as their next message, which opens a new budget.
  const continuePausedTurn = useCallback(async () => {
    await sendMessage({
      content: t("chat.turnPaused.continue"),
      id: toSafeId<"chatMessage">(createUuid()),
    });
  }, [sendMessage, t]);

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

      await resendLatestChatMessage(
        chat,
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
  // The API stores the grant and decides what it covers; it refuses tools
  // that ask on every call. This call is approved either way, since the user
  // approved it.
  const approveAndStoreGrant = useCallback(
    async (
      id: string,
      toolName: ApprovalToolName,
      scope: ChatToolGrantScope,
    ) => {
      if (
        !requiresPerCallChatApproval(toolName) &&
        !isNonPersistentGrantChatToolName(toolName)
      ) {
        const stored = await Result.tryPromise({
          try: async () =>
            await storeChatToolGrant({
              scope,
              threadId: conversationId,
              toolName,
            }),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error("Could not store the approval"),
        });
        if (Result.isError(stored)) {
          notifyError(stored.error);
        }
        await queryClient.invalidateQueries({
          queryKey: chatKeys.toolGrants(organizationId, userId, conversationId),
        });
      }
      await resolveToolApproval({ id, approved: true });
    },
    [
      conversationId,
      notifyError,
      organizationId,
      queryClient,
      resolveToolApproval,
      userId,
    ],
  );
  const confirmStoredApprovalGrant = useCallback(
    async (toolName: ApprovalToolName): Promise<boolean> => {
      // The API resolves the exact tool or connector; the cached grants only
      // decide whether to ask.
      const coverage = await Result.tryPromise(
        async () =>
          await readChatToolGrantCoverage({
            threadId: conversationId,
            toolName,
          }),
      );
      if (Result.isError(coverage) || !coverage.value.covered) {
        await queryClient.invalidateQueries({
          queryKey: chatKeys.toolGrants(organizationId, userId, conversationId),
        });
        return false;
      }
      return true;
    },
    [conversationId, organizationId, queryClient, userId],
  );
  const handleAllowInConversation = useCallback(
    async (id: string, toolName: ApprovalToolName) => {
      await approveAndStoreGrant(id, toolName, "conversation");
    },
    [approveAndStoreGrant],
  );
  const handleAlwaysAllow = useCallback(
    async (id: string, toolName: ApprovalToolName) => {
      await approveAndStoreGrant(id, toolName, "always");
    },
    [approveAndStoreGrant],
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
  // Submitting the decision and continuing the chat are separate
  // steps: once the server commits a decision, the card keeps the
  // returned receipt (never the value) and retries only the
  // continuation, so a failed continuation never re-sends the value.
  const handleRequestSecret = useCallback(
    async (
      toolCallId: string,
      decision: RequestSecretDecision,
    ): Promise<RequestSecretOutput> =>
      unwrapApiResponse(
        await api.chat
          .threads({ threadId: toSafeId<"chatThread">(conversationId) })
          .secrets({ toolCallId })
          .post(decision),
      ),
    [conversationId],
  );
  const continueRequestSecret = useCallback(
    async (toolCallId: string, receipt: RequestSecretOutput) => {
      await addToolResult({
        tool: "request_secret",
        toolCallId,
        output: receipt,
      });
    },
    [addToolResult],
  );
  // Same two steps as private input: the server confirms the connection and
  // returns the receipt, then the chat continues with it.
  const handleConnectConnector = useCallback(
    async (
      toolCallId: string,
      decision: ConnectConnectorDecision,
    ): Promise<ConnectConnectorOutput> =>
      chatConnectorReceipt.submit({
        threadId: toSafeId<"chatThread">(conversationId),
        toolCallId,
        decision,
      }),
    [conversationId],
  );
  const continueConnectConnector = useCallback(
    async (toolCallId: string, receipt: ConnectConnectorOutput) => {
      await addToolResult({
        tool: "connect_connector",
        toolCallId,
        output: receipt,
      });
    },
    [addToolResult],
  );
  const resolveSecretTarget = useCallback(
    async (
      connectorSlug: string,
      signal: AbortSignal,
    ): Promise<SecretTargetResolution> => {
      const thread = api.chat.threads({
        threadId: toSafeId<"chatThread">(conversationId),
      });
      const response = await thread["saved-secret"].get({
        query: { connectorSlug },
        fetch: { signal },
      });
      return unwrapApiResponse(response);
    },
    [conversationId],
  );

  /**
   * The one truncate-and-replay path. TanStack ChatClient has no rewind
   * primitive, so the page drops every message after the target
   * (`planTruncatedReplay`) and the replay request names the same target
   * (`truncateAfterMessageId`), so the server drops the same persisted turns
   * before the model runs again.
   *
   * The plan reads the runtime's messages when the replay starts, not the
   * rendered ones, so the callbacks built on it keep their identity while a
   * turn streams and the transcript's edit actions do not re-render.
   */
  const replayFromTruncation = useCallback(
    async <TReplayed>(
      target: TruncatedReplayTarget,
      replay: (
        options: ChatSendMessageOptions | undefined,
        /** The page's messages before the replay rewound them. */
        rewoundFrom: PersistedChatMessage[],
      ) => Promise<TReplayed>,
    ): Promise<TReplayed | null> => {
      const rewoundFrom = projectCanonicalChatUIMessages(
        chat.getSnapshot().messages,
      );
      const plan = planTruncatedReplay(rewoundFrom, target);
      if (plan === null) {
        return null;
      }
      setMessages(plan.messages);
      return await replay(
        snapshotChatRequestOptions({
          docxEditRepresentation: undefined,
          editApplyMode: undefined,
          options: { body: plan.body },
          sendMode: getSendMode?.(),
        }),
        rewoundFrom,
      );
    },
    [chat, getSendMode, setMessages],
  );

  /**
   * Answer an answered ask-user card again: its card goes back to awaiting
   * the answer, and `addToolResult` writes the new one, which drives the
   * next turn.
   */
  const handleAskUserEditAndRerun = useCallback(
    async (toolCallId: string, output: AskUserOutput) => {
      await replayFromTruncation(
        { type: "ask-user-answer", toolCallId },
        async (options) => {
          await addToolResult(
            {
              tool: "ask-user",
              toolCallId,
              output,
            },
            options,
          );
        },
      );
    },
    [addToolResult, replayFromTruncation],
  );

  /**
   * An open edit form holds the queue: the edit drops every turn after its
   * message, so nothing queued may be sent meanwhile. While any edit form of
   * this page is open and the queue has messages nothing holds yet, the page
   * pauses the server's queue, and resumes it once the last form closes
   * without sending; a sent edit releases it itself (its turn goes first and
   * the queue waits behind it).
   */
  const pauseForEdit = useCallback(async () => {
    const pause = editPauseRef.current;
    const current = readQueue();
    if (pause.paused || current.items.length === 0 || current.hold !== null) {
      return;
    }
    pause.paused = true;
    pause.paused = await writeQueue(
      async () => await pauseChatQueue(threadRef.threadId),
    );
  }, [readQueue, threadRef.threadId, writeQueue]);

  /**
   * Opening the editor of a sent message while a turn runs stops that turn
   * through the composer's Stop, so the edit can be sent once it settled.
   * The queue is paused first, so the turn's end does not send a queued
   * message ahead of the edit.
   */
  const startUserMessageEdit = useCallback(() => {
    if (!turnRuns()) {
      return;
    }
    detached(
      (async () => {
        await pauseForEdit();
        stop();
      })(),
      "use-chat-session.stop-for-edit",
    );
  }, [pauseForEdit, stop, turnRuns]);

  /** The edit form of session `sessionId` opened; the release it returns
   *  runs when that form closes. */
  const holdQueueForMessageEdit = useCallback(
    (sessionId: string) => {
      const pause = editPauseRef.current;
      pause.sessions.add(sessionId);
      detached(pauseForEdit(), "use-chat-session.pause-for-edit");
      return () => {
        pause.sessions.delete(sessionId);
        if (pause.sessions.size > 0 || !pause.paused) {
          return;
        }
        pause.paused = false;
        detached(
          writeQueue(async () => await resumeChatQueue(threadRef.threadId)),
          "use-chat-session.resume-after-edit",
        );
      };
    },
    [pauseForEdit, threadRef.threadId, writeQueue],
  );

  /**
   * Replace one of the user's own messages and run the assistant again from
   * there: the message and every later turn leave the thread, and the edited
   * message is sent under the same id. Resolves once the server accepted the
   * edit's turn or did not; when it did not, the page shows the thread as the
   * server stores it again. Should that thread no longer hold the edited
   * message, the page's edit sessions hand the edit on, as they do for a
   * message that leaves the thread any other way.
   */
  const editUserMessage = useCallback(
    async (
      messageId: string,
      edit: UserMessageEdit,
    ): Promise<UserMessageEditOutcome> => {
      const replayed = await replayFromTruncation(
        { type: "user-message", messageId },
        async (options, rewoundFrom): Promise<UserMessageEditOutcome> => {
          const acceptance = await sendThreadChatMessageUntilAccepted(
            chat,
            buildEditedUserMessage({ edit, messageId }),
            { ...options, timingSurface },
          );
          if (acceptance.status === "accepted") {
            // The edit's acceptance released the queue: nothing to resume.
            editPauseRef.current.paused = false;
            return { type: "accepted" };
          }
          await showStoredChatThread(chat, rewoundFrom);
          return userMessageEditFailure(acceptance.error);
        },
      );
      // A message the page no longer holds cannot be edited from it.
      return (
        replayed ?? {
          type: "edit-refused",
          code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing,
        }
      );
    },
    [chat, replayFromTruncation, timingSurface],
  );

  const createDocumentMattersView = queryView(
    useQuery({
      ...workspacesNavigationOptions({ organizationId, userId }),
      select: (navigation) =>
        navigation.workspaces.map((matter) => ({
          id: matter.id,
          name: matter.name,
          color: matter.color,
          client: matter.client?.displayName
            ? { displayName: matter.client.displayName }
            : null,
        })),
    }),
  );

  const handledDocumentDeletionToolCallIdsRef = useRef(new Set<string>());
  const handledDocxReplacementToolCallIdsRef = useRef(new Set<string>());
  const handledPlaybookSaveToolCallIdsRef = useRef(new Set<string>());
  const handledReaderAnnotationWriteToolCallIdsRef = useRef(new Set<string>());

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

  const playbookPaneTabId = playbookDraftTabId(threadRef.threadId);
  /** The tab label for a playbook: its cached name, until the pane reads it. */
  const playbookPaneLabel = useCallback(
    (playbookId: string) => {
      const detail = queryClient.getQueryData(
        playbookDetailOptions(organizationId, playbookId).queryKey,
      );
      return detail !== undefined && "name" in detail && detail.name !== ""
        ? detail.name
        : t("knowledge.playbooks.review.playbookLabel");
    },
    [organizationId, queryClient, t],
  );

  const isMobile = useIsMobile();
  const openedPlaybookPaneIdsRef = useRef(new Set<string>());
  const playbookPaneShown = useInspectorTabsStore((state) =>
    state.tabs.some(({ id }) => id === playbookPaneTabId),
  );
  // A pane restored with the inspector counts as opened, so closing it keeps
  // the next save from reopening it.
  useExternalSyncEffect(() => {
    if (playbookPaneShown) {
      openedPlaybookPaneIdsRef.current.add(playbookPaneTabId);
    }
  }, [playbookPaneShown, playbookPaneTabId]);
  /** Opens (or focuses) this thread's playbook pane on `playbookId`. */
  const handleOpenPlaybook = useCallback(
    (playbookId: string) => {
      openedPlaybookPaneIdsRef.current.add(playbookPaneTabId);
      useInspectorTabsStore.getState().openView({
        type: PLAYBOOK_DRAFT_VIEW,
        id: playbookPaneTabId,
        label: playbookPaneLabel(playbookId),
        payload: { type: "playbook", playbookId },
      });
    },
    [playbookPaneLabel, playbookPaneTabId],
  );

  /**
   * Moves or opens this thread's pane as `playbookPaneReaction` decides. A
   * save that finishes after the page moved to another thread is dropped.
   */
  const followPlaybookSave = useLatestCallback(
    ({ saved, paneTabId }: FollowPlaybookSaveOptions) => {
      if (paneTabId !== playbookPaneTabId) {
        return;
      }
      const { playbookId } = saved;
      const inspector = useInspectorTabsStore.getState();
      const tab = inspector.tabs.find(({ id }) => id === playbookPaneTabId);
      const reaction = playbookPaneReaction({
        mode: playbookPane,
        isMobile,
        openedThisSession: openedPlaybookPaneIdsRef.current.has(paneTabId),
        pane: playbookPaneState(
          tab?.type === "view" &&
            tab.viewType === PLAYBOOK_DRAFT_VIEW &&
            isPlaybookDraftViewPayload(tab.payload)
            ? tab.payload
            : null,
        ),
        saved,
      });
      switch (reaction) {
        case "none":
          return;
        case "open":
          handleOpenPlaybook(playbookId);
          return;
        case "update":
          inspector.updateView({
            id: playbookPaneTabId,
            label: playbookPaneLabel(playbookId),
            payload: { type: "playbook", playbookId },
          });
          return;
        default:
          reaction satisfies never;
          panic(`Unhandled playbook pane reaction: ${String(reaction)}`);
      }
    },
  );

  // A chat `save_playbook` writes an org-level playbook from any surface, so
  // an open playbooks list or editor refetches once per completed save. The
  // pane follows only the newest save: a refetch that settles after a later
  // save's is dropped.
  const playbookSaveSequenceRef = useRef(0);
  const observedPlaybookSaveRuntimesRef = useRef(new WeakSet<object>());
  useExternalSyncEffect(() => {
    const source = observedPlaybookSaveRuntimesRef.current.has(chat)
      ? "live"
      : "history";
    observedPlaybookSaveRuntimesRef.current.add(chat);
    const reconciliation = reconcilePlaybookSaveToolCalls({
      handledToolCallIds: handledPlaybookSaveToolCallIdsRef.current,
      historicalToolCallIds: historicalPlaybookSaveToolCallIdsRef.current,
      messages,
      organizationId,
      playbookKeys: knowledgeKeys.playbooks,
      queryClient,
      source,
    });
    if (reconciliation === null) {
      return;
    }
    const paneTabId = playbookPaneTabId;
    if (reconciliation.target?.source === "live") {
      playbookSaveSequenceRef.current += 1;
    }
    const sequence = playbookSaveSequenceRef.current;
    const requestedChat = chat;
    detached(
      followReconciledPlaybookSave({
        reconciliation,
        isCurrent: () =>
          seededChatRef.current === requestedChat &&
          playbookSaveSequenceRef.current === sequence,
        follow: (saved) => followPlaybookSave({ saved, paneTabId }),
      }),
      "use-chat-session.reconcile-playbook-save-tool-calls",
    );
  }, [
    chat,
    followPlaybookSave,
    messages,
    organizationId,
    playbookPaneTabId,
    queryClient,
  ]);

  // A chat highlight or comment on the open decision or statute writes outside
  // the reader's own mutations, so its margin refetches once per completed write.
  useExternalSyncEffect(() => {
    detached(
      reconcileReaderAnnotationWriteToolCalls({
        handledToolCallIds: handledReaderAnnotationWriteToolCallIdsRef.current,
        messages,
        queryClient,
      }),
      "use-chat-session.reconcile-reader-annotation-write-tool-calls",
    );
  }, [messages, queryClient]);

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
        const downloadResult = await downloadCreateDocumentDraft(
          toolCallId,
          input,
        );
        if (Result.isError(downloadResult)) {
          getAnalytics().captureError(downloadResult.error, {
            fingerprintKey: "useChatSession:failure-3",
            scope: { type: "handler", handlerId: exceptionHandlerId },
          });
        }
        if (
          Result.isError(downloadResult) ||
          downloadResult.value.status === "invalid-source"
        ) {
          notifyUserError(
            Result.isError(downloadResult) ? downloadResult.error : undefined,
            t("chat.createDocument.failedHeader"),
          );
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
        const href = entityReferenceHref({
          entityId: created.entityId,
          matterId,
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
        getAnalytics().captureError(createResult.error, {
          fingerprintKey: "useChatSession:failure-4",
          scope: { type: "handler", handlerId: exceptionHandlerId },
        });
        notifyUserError(
          createResult.error,
          APIError.is(createResult.error)
            ? internalToolErrorMessage(createResult.error)
            : t("chat.createDocument.failedHeader"),
        );
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
        await openCreatedDocumentInInspector(
          output,
          getCurrentWorkspaceDocument(router.state.matches),
        );
      }
    },
    [chat, queryClient, router, setMessages, t, threadRef, exceptionHandlerId],
  );

  const handleOpenCreatedDocument = useCallback(
    async (output: CreateDocumentMatterSuccess) => {
      await openCreatedDocumentInInspector(
        output,
        getCurrentWorkspaceDocument(router.state.matches),
      );
    },
    [router],
  );
  const streamdownComponents = useMemo(
    () => ({
      table: (props: Omit<ChatTableChartProps, "cacheScope">) =>
        createElement(LazyChatTableChart, {
          ...props,
          cacheScope: [organizationId, userId],
        }),
      a: (props: ComponentProps<"a">) =>
        createElement(StreamdownMentionLink, {
          ...props,
          interactive: true,
          workspaceId,
        }),
      "stll-anon": (props: ComponentProps<"button"> & { ph?: string }) =>
        createElement(AnonymizedSpan, props),
    }),
    [workspaceId, organizationId, userId],
  );

  const approvalPendingMessageId = useMemo(
    () => getCurrentApprovalPendingMessageId(messages),
    [messages],
  );

  const isGenerating = useMemo(
    () =>
      isChatTurnGenerating({
        hasError: error !== undefined,
        messages,
        requestActive: reconnecting || isChatClientRequestActive(status),
        sessionGenerating,
        stopStatus: stopState.status,
      }),
    [
      error,
      messages,
      reconnecting,
      sessionGenerating,
      status,
      stopState.status,
    ],
  );
  // A turn runs, or the client's request has not ended: TanStack can report a
  // turn ready while it still loads.
  const turnRunning = isGenerating || clientLoading;
  // A turn paused on the member: an approval or a question is open.
  const turnAwaitsMember =
    openMemberWaitKeys({
      localRunQuestion: snapshot.localRunQuestion,
      messages,
    }).length > 0;
  useChatTurnNotifications({
    conversationId,
    phase: getChatTurnPhase({
      awaitingUser: getAwaitedAssistantMessageId(messages) !== null,
      hasError: error !== undefined,
      isGenerating,
    }),
  });

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

  // A Stop the server refused leaves the turn running and Stop available;
  // say so once per refusal.
  const lastStopFailureRef = useRef<Error | undefined>(undefined);
  useExternalSyncEffect(() => {
    if (stopState.status !== "failed") {
      return;
    }
    if (lastStopFailureRef.current === stopState.error) {
      return;
    }
    lastStopFailureRef.current = stopState.error;
    getAnalytics().captureError(stopState.error, {
      fingerprintKey: "useChatSession:failure-5",
      scope: { type: "handler", handlerId: exceptionHandlerId },
    });
    notifyUserError(stopState.error, t("chat.stopFailed"));
  }, [stopState, t, exceptionHandlerId]);

  // A message steered into a turn that waited on the member goes to it once
  // the declined wait lets it run again. Taken, it leaves the queue; not
  // taken, it stays queued for the turn's end.
  useExternalSyncEffect(() => {
    const steered = steerOnResumeRef.current;
    if (steered === null || !turnRunning) {
      return;
    }
    steerOnResumeRef.current = null;
    detached(
      (async () => {
        if ((await chat.steerLocalTurn(steered)) === "steered") {
          await writeQueue(async () => await removeFromQueue(steered.id));
        }
      })(),
      "use-chat-session.steer-on-resume",
    );
  }, [chat, removeFromQueue, turnRunning, writeQueue]);

  // The server sends the first queued message as a turn of its own, which
  // this page did not start: once that message has left the queue (not
  // removed from this page) and the page runs nothing, the page reads the
  // thread again, and the runtime the read rebuilds joins the running turn.
  const queueHeadId = chatQueue.items.at(0)?.id ?? null;
  const queuedIds = chatQueue.items.map(({ id }) => id).join(" ");
  const seenQueueHeadRef = useRef<string | null>(null);
  useExternalSyncEffect(() => {
    // While a turn of this page runs, the head it last saw stays the one to
    // compare with: the server sends from the queue only once that turn
    // has ended.
    if (turnRunning) {
      return;
    }
    const seen = seenQueueHeadRef.current;
    seenQueueHeadRef.current = queueHeadId;
    if (
      seen === null ||
      queuedIds.split(" ").includes(seen) ||
      removedHereRef.current.has(seen)
    ) {
      return;
    }
    detached(
      invalidateChatThreadAcrossScopes({
        queryClient,
        threadId: threadRef.threadId,
      }),
      "use-chat-session.join-queued-turn",
    );
  }, [queryClient, queueHeadId, queuedIds, threadRef.threadId, turnRunning]);

  return {
    activitySession: chat,
    approvalIdsAwaitedAtOpen: workAwaitedAtOpen.approvalIds,
    workAwaitedAtOpen,
    clientStatus: status,
    reconnecting,
    refreshAnswers,
    error,
    messages,
    loadOlder,
    olderCursor,
    isLoadingOlder,
    loadOlderError,
    resendLatestMessage,
    sendMessage,
    queueMessage,
    continuePausedTurn,
    queue,
    editQueuedMessage,
    moveQueuedMessage,
    pauseQueue,
    removeQueuedMessage,
    replaceWithQueuedMessage,
    resumeQueue,
    sendQueuedMessageNow,
    stop,
    leave,
    isGenerating,
    /** The turn waits on the member: an approval or a question is open. */
    turnAwaitsMember,
    /** A stop was asked for and the turn has not ended yet. */
    stopPending: stopState.status === "pending",
    turnAbandoned,
    computerWait,
    turnSentAt,
    turnsStarted,
    alwaysApprovedTools,
    conversationApprovedTools,
    handleApprove,
    handleAllowInConversation,
    handleDeny,
    handleAskUserSubmit,
    handleRequestSecret,
    continueRequestSecret,
    handleConnectConnector,
    continueConnectConnector,
    resolveSecretTarget,
    secretAvailabilityKey: conversationId,
    handleAskUserEditAndRerun,
    startUserMessageEdit,
    holdQueueForMessageEdit,
    editUserMessage,
    handleAlwaysAllow,
    confirmStoredApprovalGrant,
    handleCreateDocumentResolve,
    handleOpenCreateDocumentDraft,
    handleOpenCreatedDocument,
    handleOpenPlaybook,
    createDocumentMattersView,
    addToolResult,
    streamdownComponents,
    approvalPendingMessageId,
    localRunQuestion: snapshot.localRunQuestion,
    answerLocalRunQuestion: chat.answerLocalRunQuestion,
  };
};
