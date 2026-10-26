import { useCallback, useRef, useState } from "react";
/**
 * Inspector chat tab — full-fat chat surface backed by the same
 * `/chat` endpoint, persistence layer, and `useChat` runtime as the
 * legacy right-panel chat. We layer that runtime under our own
 * shell (ribbon + matter picker + glass-pill bar) so the surface
 * looks like it belongs to the inspector while every "real chat"
 * concern (streaming, mentions, tool approvals, drafts, history)
 * is handled by the existing primitives.
 *
 * Responsibilities here:
 *   - resolve a `Chat` instance from `chatThreadOptions`
 *   - drive `useChatSession` to expose messages + send/stop + tool
 *     approval handlers
 *   - render `ChatThreadMessages` for the transcript
 *   - render the shared `PromptBar` for the composer
 */
import type { MouseEvent } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { Button } from "@stll/ui/button";
import { Maximize2Icon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  Conversation,
  ConversationContent,
  ConversationScrollProvider,
} from "@/components/ai-elements/conversation";
import { PromptBar } from "@/components/ai-suggestions/host";
import { useMainLegalDocument } from "@/components/ai-suggestions/use-main-legal-document";
import {
  CHAT_SEND_KEPT,
  CHAT_SEND_SENT,
  useChatEditor,
} from "@/components/chat-editor-provider";
import type {
  ChatDraftAttachment,
  ChatSendOutcome,
} from "@/components/chat-editor-provider";
import {
  composerStoredMarkdown,
  composerText,
} from "@/components/chat-editor-source";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import {
  ChatMatterPicker,
  ChatMatterPickerPending,
} from "@/components/chat/chat-matter-picker";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import {
  DockedComposer,
  PromptBarPending,
  PromptBarPlaceholderContent,
} from "@/components/chat/docked-composer";
import { PromptSuggestions } from "@/components/chat/prompt-suggestions";
import {
  boundLegalDocumentLabel,
  chatContextLabel,
  chatTabHeaderLabel,
} from "@/components/inspector/chat-context-label.logic";
import { useDecisionChatPrompts } from "@/components/inspector/decision-chat-prompts";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { ChatTab } from "@/components/inspector/inspector-tabs-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { buildMaximizeTabAction } from "@/components/inspector/maximize-tab";
import { dockNewChatArgs } from "@/components/inspector/new-chat-scope";
import { useRouteWorkspaceId } from "@/components/inspector/use-route-workspace-id";
import {
  AIUnavailableDialogTrigger,
  useAIKeyGate,
} from "@/components/require-ai-key";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { ChatTitleSuggestButton } from "@/features/chat/components/chat-title-rename";
import { SuggestedFollowupChips } from "@/features/chat/components/suggested-followup-chips";
import { useChatSession } from "@/features/chat/hooks/use-chat-session";
import { useChatThreadRuntime } from "@/features/chat/hooks/use-chat-thread-runtime";
import { useChatUserContext } from "@/features/chat/hooks/use-chat-user-context";
import { useRenameChatThread } from "@/features/chat/hooks/use-rename-chat-thread";
import { useSuggestChatThreadTitle } from "@/features/chat/hooks/use-suggest-chat-thread-title";
import { useSuggestedFollowupPrompts } from "@/features/chat/hooks/use-suggested-followup-prompts";
import { legalDocumentChatContext } from "@/features/chat/legal-document-chat-context";
import { buildChatRequestMessage } from "@/features/chat/lib/build-chat-request-message";
import { startNewThreadCommandHandoff } from "@/features/chat/lib/start-new-thread-command-handoff";
import { chatThreadOptions } from "@/features/chat/queries";
import {
  claimQueuedChatSend,
  hasQueuedChatSend,
  settleQueuedChatSend,
  subscribeQueuedChatSend,
} from "@/features/chat/queued-chat-sends";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  getChatSendMode,
  useChatAnonymized,
} from "@/lib/chat-anonymized-store";
import {
  type ChatThreadRef,
  createChatThreadId,
  getChatThreadKey,
} from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useSkillLabel } from "@/lib/knowledge/built-in-skills";
import type { PromptSuggestion } from "@/lib/prompts/types";
import { useSuggestedSkills } from "@/lib/prompts/use-suggested-skills";
import { queryView } from "@/lib/query-view.logic";
import { runReservedChatCommand } from "@/lib/reserved-chat-commands";
import { useQueryViewError } from "@/lib/use-query-view";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

type ChatTabPanelProps = {
  tab: ChatTab;
  onClose: () => void;
  onLabelContextMenu: (event: MouseEvent<HTMLElement>) => void;
};

const chatTabThreadRef = (tab: ChatTab): ChatThreadRef =>
  tab.workspaceId === undefined
    ? { scope: "global", threadId: tab.id }
    : {
        scope: "workspace",
        threadId: tab.id,
        workspaceId: tab.workspaceId,
      };

export const ChatTabPanel = ({
  tab,
  onClose,
  onLabelContextMenu,
}: ChatTabPanelProps) => {
  // The inspector pane mounts under a workspace route, but the
  // *thread* itself can be either workspace-scoped (chat lives
  // under a matter) or global (chat lives at /chat/$threadId).
  // Use the tab's own workspaceId — undefined means global.
  const tabWorkspaceId = tab.workspaceId;
  const userContext = useChatUserContext();
  // useLatestCallback so the chat transport's `getUserContext` is a
  // stable reference across renders (matches legacy chat's pattern
  // — keeps Chat<>'s prepareSendMessagesRequest from re-binding).
  const getUserContext = useLatestCallback(() => userContext);
  // Same pattern for the legal-document context — it's per-tab metadata
  // that changes only when openChat() is re-invoked, so capturing
  // the current value via useLatestCallback keeps the transport's
  // request shape stable across renders.
  const tabLegalKey = tab.activeLegalKey;
  const getTabLegalKey = useLatestCallback(() => tabLegalKey);
  // Which corpus the tab is bound to decides which getter it carries, so a
  // tab about a consolidation sends it the way the statute reader does.
  const legalChatContext =
    tabLegalKey === undefined
      ? {}
      : legalDocumentChatContext({
          documentKey: tabLegalKey,
          readDocumentKey: getTabLegalKey,
        });
  const tabActiveSkill = tab.activeSkill;
  const getActiveSkill = useLatestCallback(() => tabActiveSkill);
  const t = useTranslations();
  const capturePromptSubmitError = useCallback(
    (error: unknown): void => {
      getAnalytics().captureError(error, {
        fingerprintKey: "ChatTabPanel:failure",
        scope: { type: "handler", handlerId: "ChatTabPanel:failure" },
      });
      notifyUserError(error, t("common.somethingWentWrong"));
    },
    [t],
  );
  const { ensureAIAvailable } = useAIKeyGate();

  // Read live tab state on every send. The Chat instance is created
  // once and cached per `threadRef`, so a plain closure over `tab`
  // would freeze the IDs from the render that built the instance —
  // picker updates would land in the store but never reach the
  // server. `useLatestCallback` always reads the latest closure values.
  const getContextMatterIds = useLatestCallback(() => tab.contextMatterIds);
  const threadRef = chatTabThreadRef(tab);
  // Display and send read one shared per-thread send-mode source: the
  // dock's shield renders `useChatAnonymized(threadRef)` while the
  // transport's `getSendMode` reads `getChatSendMode(threadRef)` — the
  // same store — so the shield can never show a state the next request
  // won't honour.
  const anonymized = useChatAnonymized(threadRef);
  const [composerFocused, setComposerFocused] = useState(false);
  const getSendMode = useLatestCallback(() => getChatSendMode(threadRef));
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const contextLabel = useChatContextLabel(tab, activeOrganizationId);

  const {
    markChatStarted,
    openChat,
    resetChatTabId,
    setChatContext,
    updateLabel,
  } = useInspectorTabsStore(
    useShallow((s) => ({
      markChatStarted: s.markChatStarted,
      openChat: s.openChat,
      resetChatTabId: s.resetChatTabId,
      setChatContext: s.setChatContext,
      updateLabel: s.updateLabel,
    })),
  );
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const moveToMain = buildMaximizeTabAction(tab, {
    activeOrganizationId,
    navigate,
    queryClient,
  });

  // Tab id is generated client-side at openChat() time; the thread
  // doesn't exist server-side until the first message lands. Allow
  // the missing-thread response so the GET doesn't 404 on a fresh
  // tab; the thread will be created idempotently on the first send.
  const chatThreadContext = {
    allowMissingThread: true,
    getUserContext,
    ...legalChatContext,
    ...(tabActiveSkill ? { getActiveSkill } : {}),
    getContextMatterIds,
    getSendMode,
  };
  const { data } = useSuspenseQuery(
    chatThreadOptions({
      activeOrganizationId,
      key: threadRef,
      context: chatThreadContext,
    }),
  );
  const chat = useChatThreadRuntime({
    activeOrganizationId,
    context: chatThreadContext,
    data,
    key: threadRef,
  });

  const {
    activitySession,
    error,
    messages,
    refreshAnswers,
    loadOlder,
    olderCursor,
    isLoadingOlder,
    loadOlderError,
    resendLatestMessage,
    sendMessage,
    queuedMessages,
    removeQueuedMessage,
    sendQueuedMessageNow,
    stop,
    leave,
    isGenerating,
    turnAbandoned,
    alwaysApprovedTools,
    conversationApprovedTools,
    confirmStoredApprovalGrant,
    handleApprove,
    handleAllowInConversation,
    handleDeny,
    handleRequestSecret,
    continueRequestSecret,
    resolveSecretTarget,
    secretAvailabilityKey,
    handleAskUserSubmit,
    handleAskUserEditAndRerun,
    handleAlwaysAllow,
    handleCreateDocumentResolve,
    handleOpenCreateDocumentDraft,
    handleOpenCreatedDocument,
    handleOpenPlaybook,
    createDocumentMattersView,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({
    exceptionScope: { type: "handler", handlerId: "chat-session.inspector" },
    chat,
    timingSurface: "inspector-chat",
    conversationId: threadRef.threadId,
    getContextMatterIds,
    getSendMode,
    initialOlderCursor: data.olderCursor,
    playbookPane: "on-request",
    threadRef,
    workspaceId: tabWorkspaceId,
  });
  const handlePromptSubmit = useLatestCallback(
    async ({
      prompt,
      files,
    }: {
      prompt: string;
      files: ChatDraftAttachment[];
    }): Promise<ChatSendOutcome> => {
      try {
        if (!(await ensureAIAvailable())) {
          return CHAT_SEND_KEPT;
        }

        // PromptBar emits the raw editor HTML; the backend parses
        // `<entity-mention>` tags out of TanStack text content.
        await sendMessage(
          await buildChatRequestMessage({ files, html: prompt }),
        );
        return CHAT_SEND_SENT;
      } catch (submitError) {
        // Reported here, so the composer only takes the draft back.
        capturePromptSubmitError(submitError);
        return CHAT_SEND_KEPT;
      }
    },
  );

  const {
    handleAskUserEditingChange,
    lastMessageId,
    suggestedFollowupPrompt,
    suggestedPrompts,
  } = useSuggestedFollowupPrompts({
    activeOrganizationId,
    approvalPendingMessageId,
    error,
    isGenerating,
    messages,
    threadRef,
    turnAbandoned,
  });
  // TipTap composer for this thread — `@`-mention chips, drafts,
  // attachments come from the same provider as the right-panel
  // chat. Thread ref is shared with `chatThreadOptions` above so
  // drafts persist across tab close/open.
  const editorController = useChatEditor({
    followupAnalytics: { surface: "inspector-chat" },
    placeholder: t("chat.contextPlaceholder", { context: contextLabel }),
    suggestedFollowupPrompt,
    threadRef,
  });
  const hasSuggestedFollowups = suggestedPrompts.length > 0;
  const focusComposer = editorController.focus;
  const sendWithoutAnonymization = useLatestCallback(async () => {
    await resendLatestMessage({ sendMode: CHAT_SEND_MODE.rawOverride });
  });

  useExternalSyncEffect(() => {
    if (messages.length > 0 || isGenerating) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      focusComposer();
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [focusComposer, isGenerating, messages.length, tab.id]);

  const suggestedSkills = useSuggestedSkills();
  // A chat about a decision opens on the questions a judgment answers. The
  // suggested skills are the reader's own drafting and review skills, which are
  // about a document they are writing, not one a court handed down.
  const decisionPrompts = useDecisionChatPrompts(tabLegalKey);
  const emptyStatePrompts = decisionPrompts ?? suggestedSkills;
  const handleSelectPrompt = (prompt: PromptSuggestion) => {
    editorController.setContent(composerStoredMarkdown(prompt.body));
    editorController.focus();
  };

  // Inline rename — same UX as file tabs, plus a write-through to the
  // persisted conversation title once the thread has messages. Without the
  // write-through, renaming a docked chat would change only the local tab
  // label while the real conversation title stayed stale on every other
  // surface. Pre-first-message renames stay label-only, as before.
  const renameThread = useRenameChatThread(threadRef);
  const hasThreadMessages = messages.length > 0;
  // The tab store keeps a document's chat across reloads only once its
  // conversation exists on the server.
  useExternalSyncEffect(() => {
    if (hasThreadMessages && tab.started !== true) {
      markChatStarted(tab.id);
    }
  }, [hasThreadMessages, markChatStarted, tab.id, tab.started]);
  // The optimistic label write needs its own rollback: the mutation's
  // onError restores the query caches but cannot reach this local tabs
  // store, and a failed PATCH must not leave the tab showing a title the
  // server rejected.
  const renameThreadWithLabel = (value: string) => {
    const previousLabel = tab.label;
    updateLabel(tab.id, value);
    renameThread.mutate(value, {
      onError: () => {
        updateLabel(tab.id, previousLabel);
      },
    });
  };
  const labelRename = useInlineRename({
    initial: tab.label,
    onCommit: (value) => {
      if (hasThreadMessages) {
        renameThreadWithLabel(value);
        return;
      }
      updateLabel(tab.id, value);
    },
  });

  // Mirrors of the label edit session, maintained at the handlers below, so
  // the async title suggestion can tell whether the user typed, cancelled,
  // or committed while the request was in flight (same stale-draft guard as
  // `ChatTitleRename`).
  const labelDraftRef = useRef<string | null>(null);
  const labelSessionRef = useRef(0);
  const startLabelEditing = () => {
    labelSessionRef.current += 1;
    labelDraftRef.current = tab.label;
    labelRename.startEditing();
  };
  const { suggest: suggestTitle, isPending: isSuggestingTitle } =
    useSuggestChatThreadTitle(threadRef);
  const suggestTitleIntoLabel = async () => {
    const session = labelSessionRef.current;
    const baseline = labelDraftRef.current;
    const suggestion = await suggestTitle();
    if (suggestion === null) {
      return;
    }
    if (
      labelSessionRef.current !== session ||
      labelDraftRef.current !== baseline
    ) {
      return;
    }
    labelDraftRef.current = suggestion;
    labelRename.setDraft(suggestion);
  };
  const startLabelEditingWithSuggestion = () => {
    startLabelEditing();
    // Same disabled-wand states re-checked for the `/rename-chat` path: an
    // anonymized thread refuses suggestions (server-enforced 403), so open
    // the plain editor instead of firing a doomed request.
    if (data.usedAnonymization || !hasThreadMessages) {
      return;
    }
    detached(
      suggestTitleIntoLabel(),
      "chat-tab-panel.suggest-title-into-label",
    );
  };

  // New-chat lives in the composer's status row (the dock), not the
  // pane header: opens a fresh tab scoped to the route's matter.
  const routeWorkspaceId = useRouteWorkspaceId();
  const startNewThread = () => {
    openChat(
      dockNewChatArgs({ id: createChatThreadId(), routeWorkspaceId, tab }),
    );
  };

  // The shared tab context menu (right-click on rail icon or
  // ribbon label) dispatches `requestRename(tabId)` to the store.
  // PDF tabs read that flag in InspectorPanel; chat tabs own their
  // rename state locally so they consume the flag here.
  const consumeRenameRequest = useLatestCallback(() => {
    const store = useInspectorCommandStore.getState();
    if (store.pendingRenameTabId === tab.id) {
      startLabelEditing();
      store.clearRenameRequest();
    }
  });
  useMountEffect(() => {
    consumeRenameRequest();
    return useInspectorCommandStore.subscribe(consumeRenameRequest);
  });

  // A surface that opened this tab with its question queued ("Ask in chat"):
  // send it once, through the same AI check and session a typed message takes.
  // The question is claimed only once that check passes: while it fails (no
  // key yet, or the check itself failed) the question stays queued, and asking
  // again retries here instead of losing it.
  const queuedSendInFlight = useRef(false);
  const sendQueuedQuestion = useLatestCallback(async () => {
    if (queuedSendInFlight.current || !hasQueuedChatSend(threadRef)) {
      return;
    }
    queuedSendInFlight.current = true;
    try {
      if (!(await ensureAIAvailable())) {
        return;
      }
      const queuedHtml = claimQueuedChatSend(threadRef);
      if (queuedHtml === null) {
        return;
      }
      const outcome = await handlePromptSubmit({
        prompt: queuedHtml,
        files: [],
      });
      // A question that was not sent waits again, so the next attempt sends
      // it instead of losing it.
      settleQueuedChatSend(
        threadRef,
        outcome.kind === "sent" ? "sent" : "not-sent",
      );
    } finally {
      queuedSendInFlight.current = false;
    }
  });
  useMountEffect(() => {
    detached(sendQueuedQuestion(), "chat-tab-panel.queued-send");
    return subscribeQueuedChatSend(threadRef, () => {
      detached(sendQueuedQuestion(), "chat-tab-panel.queued-send");
    });
  });

  const handleComposerSubmit = useLatestCallback(
    async ({
      prompt,
      files,
    }: {
      prompt: string;
      files: ChatDraftAttachment[];
    }): Promise<ChatSendOutcome> => {
      const newThreadMessages: string[] = [];
      const handledReserved = runReservedChatCommand(prompt, {
        new: (args) => {
          if (args.length > 0) {
            newThreadMessages.push(args);
            return;
          }
          leave();
          resetChatTabId(tab.id, createChatThreadId());
          editorController.setContent(composerText(""));
        },
        "rename-chat": (args) => {
          editorController.setContent(composerText(""));
          if (!hasThreadMessages) {
            stellaToast.add({
              title: t("chat.renameUnavailableEmptyThread"),
              type: "info",
            });
            return;
          }
          if (args.length > 0) {
            renameThreadWithLabel(args);
            return;
          }
          startLabelEditingWithSuggestion();
        },
      });
      if (!handledReserved) {
        return await handlePromptSubmit({ prompt, files });
      }

      const newThreadMessage = newThreadMessages.at(0);
      if (newThreadMessage === undefined) {
        return CHAT_SEND_SENT;
      }
      if (!(await ensureAIAvailable())) {
        return CHAT_SEND_KEPT;
      }
      const newThreadId = createChatThreadId();
      const newThreadRef: ChatThreadRef =
        tabWorkspaceId === undefined
          ? { scope: "global", threadId: newThreadId }
          : {
              scope: "workspace",
              threadId: newThreadId,
              workspaceId: tabWorkspaceId,
            };
      await startNewThreadCommandHandoff({
        activeOrganizationId,
        context: {
          ...chatThreadContext,
          getSendMode: () => getChatSendMode(newThreadRef),
        },
        files,
        html: newThreadMessage,
        queryClient,
        threadRef: newThreadRef,
      });
      leave();
      resetChatTabId(tab.id, newThreadId);
      return CHAT_SEND_SENT;
    },
  );

  return (
    <ChatMattersContext value={{ createDocumentMattersView }}>
      <AIUnavailableDialogTrigger />
      <ChatApprovalContext
        value={{
          activeOrganizationId,
          alwaysApprovedTools,
          conversationApprovedTools,
          confirmStoredApprovalGrant,
          handleAllowInConversation,
          handleAlwaysAllow,
          handleApprove,
          handleDeny,
          handleRequestSecret,
          continueRequestSecret,
          resolveSecretTarget,
          secretAvailabilityKey,
        }}
      >
        <ChatTabPanelChrome
          onClose={onClose}
          onLabelContextMenu={onLabelContextMenu}
          onMoveToMain={moveToMain}
          onStartRename={startLabelEditing}
          rename={{
            active: labelRename.state.mode === "edit",
            value:
              labelRename.state.mode === "edit" ? labelRename.state.draft : "",
            onChange: (value) => {
              labelDraftRef.current = value;
              labelRename.setDraft(value);
            },
            onCommit: () => {
              labelSessionRef.current += 1;
              labelDraftRef.current = null;
              detached(labelRename.commit(), "chat-tab-panel.commit");
            },
            onCancel: () => {
              labelSessionRef.current += 1;
              labelDraftRef.current = null;
              labelRename.cancel();
            },
            action: (
              <ChatTitleSuggestButton
                hasMessages={hasThreadMessages}
                isPending={isSuggestingTitle}
                onTrigger={() => {
                  detached(
                    suggestTitleIntoLabel(),
                    "chat-tab-panel.suggest-title-into-label",
                  );
                }}
                usedAnonymization={data.usedAnonymization}
              />
            ),
          }}
          tab={tab}
        >
          <Conversation className="min-h-0 flex-1">
            {/* Bottom padding keeps the last messages readable above the
                floating composer block (veil + pill + status row). Extra
                space when follow-up chips are showing so Copy/Retry can
                scroll clear of the chip row. */}
            <ConversationContent
              className={cn("gap-3", hasSuggestedFollowups ? "pb-44" : "pb-32")}
            >
              {messages.length === 0 && !isGenerating && !error ? (
                <ChatEmptyState
                  onSelectPrompt={handleSelectPrompt}
                  prompts={emptyStatePrompts}
                />
              ) : (
                <ChatThreadMessages
                  activitySession={activitySession}
                  onAnswerEdited={refreshAnswers}
                  answerRewriteAvailability={
                    data.usedAnonymization ? "anonymized" : "available"
                  }
                  approvalPendingMessageId={approvalPendingMessageId}
                  branchSource={{
                    contextMatterIds: tab.contextMatterIds,
                    threadRef,
                  }}
                  error={error}
                  hasOlderMessages={olderCursor !== null}
                  isGenerating={isGenerating}
                  isLoadingOlder={isLoadingOlder}
                  loadOlderError={loadOlderError}
                  messages={messages}
                  onAskUserEditAndRerun={handleAskUserEditAndRerun}
                  onAskUserEditingChange={handleAskUserEditingChange}
                  onLoadOlder={loadOlder}
                  onAskUserSubmit={handleAskUserSubmit}
                  onCreateDocumentResolve={handleCreateDocumentResolve}
                  onOpenCreateDocumentDraft={handleOpenCreateDocumentDraft}
                  onOpenCreatedDocument={handleOpenCreatedDocument}
                  onOpenPlaybook={handleOpenPlaybook}
                  onResend={resendLatestMessage}
                  onSendWithoutAnonymization={sendWithoutAnonymization}
                  queuedMessageActions={{
                    remove: removeQueuedMessage,
                    sendNow: sendQueuedMessageNow,
                  }}
                  queuedMessages={queuedMessages}
                  showThinkingIndicator
                  streamdownComponents={streamdownComponents}
                  workspaceId={tabWorkspaceId}
                />
              )}
            </ConversationContent>
          </Conversation>

          <ChatAnonymizationLayer
            editor={editorController.editor}
            enabled={anonymized}
            focused={composerFocused}
            ownerKey={getChatThreadKey(threadRef)}
            workspaceId={tabWorkspaceId ?? threadRef.threadId}
          />
          {/* PromptBar owns its own docked positioning (via
              DockedComposer): it floats over the transcript, centred and
              pinned to the pane's bottom, identically to the file-overlay
              chat. The chips ride the same one geometry through the
              `followupChips` slot. */}
          <PromptBar
            anonymized={anonymized}
            attachmentsEnabled
            context={{ activeOrganizationId, threadRef }}
            editorController={editorController}
            emptyPlaceholder={
              <PromptBarPlaceholderContent>
                {t("chat.contextPlaceholder", { context: contextLabel })}
              </PromptBarPlaceholderContent>
            }
            followupChips={
              <SuggestedFollowupChips
                analyticsSurface="inspector-chat"
                messageId={lastMessageId}
                onSelect={(prompt) => {
                  editorController.setContent(composerStoredMarkdown(prompt));
                  detached(
                    editorController.submit(async (draft) => {
                      if (!(await ensureAIAvailable())) {
                        return CHAT_SEND_KEPT;
                      }
                      await sendMessage(await buildChatRequestMessage(draft));
                      return CHAT_SEND_SENT;
                    }),
                    "chat-tab-panel.submit",
                  );
                }}
                prompts={suggestedPrompts}
                threadId={threadRef.threadId}
              />
            }
            layout="standalone"
            onFocusChange={setComposerFocused}
            onSubmitError={capturePromptSubmitError}
            onStop={() => {
              stop();
            }}
            onNewThread={messages.length > 0 ? startNewThread : null}
            onSubmit={handleComposerSubmit}
            pendingCount={0}
            queueWhileGenerating
            reservedCommands={{ hasPersistedThread: hasThreadMessages }}
            skillChat={{
              contextMatterIds: tab.contextMatterIds,
              document: null,
              threadRef,
              webSearch: {
                available: data.webSearchAvailable,
                enabled: data.webSearchEnabled,
              },
            }}
            skillsOrganizationId={activeOrganizationId}
            status={isGenerating ? "generating" : "idle"}
            dock={
              <ChatComposerDock
                data={data}
                leadingContext={
                  <ChatMatterPicker
                    matterIds={tab.contextMatterIds}
                    onChange={(next) => setChatContext(tab.id, next)}
                  />
                }
                onNewThread={messages.length > 0 ? startNewThread : null}
                status="ready"
                threadRef={threadRef}
              />
            }
          />
        </ChatTabPanelChrome>
      </ChatApprovalContext>
    </ChatMattersContext>
  );
};

/** The bound document's name, while the reader is looking at that document. */
const useBoundLegalDocumentLabel = (tab: ChatTab): string | undefined => {
  const mainDocument = useMainLegalDocument();
  return boundLegalDocumentLabel({
    activeLegalKey: tab.activeLegalKey,
    mainDocument,
  });
};

const useChatContextLabel = (tab: ChatTab, activeOrganizationId: string) => {
  const t = useTranslations();
  const skillLabel = useSkillLabel();
  const { id: userId } = useAuthenticatedUser();
  const dataQuery = useQuery(
    workspacesNavigationOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
  );
  const dataView = queryView(dataQuery);
  useQueryViewError(dataView, "useChatContextLabel:query");
  const data = dataView.type === "items" ? dataView.items : undefined;
  const boundDocumentLabel = useBoundLegalDocumentLabel(tab);
  const workspaces = data?.workspaces ?? [];
  const matterNames = tab.contextMatterIds
    .map((id) => workspaces.find((workspace) => workspace.id === id)?.name)
    .filter((name): name is string => name !== undefined);

  return chatContextLabel({
    activeSkillName:
      tab.activeSkill === undefined ? undefined : skillLabel(tab.activeSkill),
    boundDocumentLabel,
    matterNames,
    newChatLabel: t("chat.newChat"),
    tabLabel: tab.label,
  });
};

type ChatEmptyStateProps = {
  prompts: readonly PromptSuggestion[];
  onSelectPrompt: (prompt: PromptSuggestion) => void;
};

const ChatEmptyState = ({ prompts, onSelectPrompt }: ChatEmptyStateProps) => (
  <div className="m-auto flex flex-col items-center gap-6 py-12">
    <StellaMark className="text-foreground size-10" />
    <PromptSuggestions onSelect={onSelectPrompt} prompts={prompts} />
  </div>
);

const noop = () => {
  /* placeholder handler — replaced when the panel hydrates */
};

type ChatTabPanelChromeProps = {
  tab: ChatTab;
  onClose: () => void;
  onLabelContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onStartRename: () => void;
  rename: {
    active: boolean;
    value: string;
    onChange: (value: string) => void;
    onCommit: () => void;
    onCancel: () => void;
    action?: React.ReactNode;
  };
  onMoveToMain?: (() => void) | undefined;
  children: React.ReactNode;
};

/**
 * Single source of truth for the chat tab's visual chrome — the
 * outer container, header (with action buttons + matter picker),
 * dot-grid backdrop, and the inner column that hosts the
 * conversation + prompt bar. The hydrated panel and the loading
 * shell render through this same component so they can't drift
 * out of sync; the only thing that varies is the children
 * (real `Conversation` + `PromptBar` vs. an `ChatEmptyState` +
 * placeholder bar shape).
 */
const ChatTabPanelChrome = ({
  tab,
  onClose,
  onLabelContextMenu,
  onStartRename,
  rename,
  onMoveToMain,
  children,
}: ChatTabPanelChromeProps) => {
  const t = useTranslations();
  const skillLabel = useSkillLabel();
  const boundDocumentLabel = useBoundLegalDocumentLabel(tab);
  // New-chat is not a header action: it lives in the composer's status
  // row (`ChatComposerDock`), uniform with every other chat surface.
  const actions = onMoveToMain && (
    <Tooltip
      content={t("inspector.moveToMain")}
      render={
        <Button onClick={onMoveToMain} size="icon-xs" variant="ghost">
          <Maximize2Icon className="size-3.5" />
        </Button>
      }
    />
  );

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col"
      // Which conversation the pane shows, for tests that need to tell a
      // restored thread from a freshly minted one.
      data-chat-thread-id={tab.id}
      data-slot="inspector-chat-panel"
    >
      <InspectorTabHeader
        actions={actions}
        label={chatTabHeaderLabel({
          activeSkillName:
            tab.activeSkill === undefined
              ? undefined
              : skillLabel(tab.activeSkill),
          boundDocumentLabel,
          newChatLabel: t("chat.newChat"),
          tabLabel: tab.label,
        })}
        onClose={onClose}
        onLabelContextMenu={onLabelContextMenu}
        onStartRename={onStartRename}
        rename={rename}
      />

      {/* Subtle dot-grid backdrop, same as before — gives the
          translucent bar something to layer on. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ConversationScrollProvider>{children}</ConversationScrollProvider>
      </div>
    </div>
  );
};

/**
 * Visual mirror of `PromptBar` from `@/components/ai-suggestions/host`
 * — same outer shell, placeholder text on the left, disabled send
 * button on the right. Rendered while the chat tab is hydrating
 * so the user sees the bar in place; the live `PromptBar` slots
 * in once data arrives.
 */
const PromptBarPlaceholder = ({ tab }: { tab: ChatTab }) => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const contextLabel = useChatContextLabel(tab, activeOrganizationId);
  return (
    <PromptBarPending>
      {t("chat.contextPlaceholder", { context: contextLabel })}
    </PromptBarPending>
  );
};

/**
 * Visually-faithful placeholder rendered while the chat thread
 * fetch resolves. Identical chrome to the hydrated panel — the
 * only differences are no-op handlers and a placeholder prompt
 * bar in place of the live one — so the user sees the expected
 * interface immediately and the data hydrates a frame later, no
 * spinner flash, no layout shift.
 */
export const ChatTabPanelShell = ({ tab }: { tab: ChatTab }) => {
  const suggestedSkills = useSuggestedSkills();
  const decisionPrompts = useDecisionChatPrompts(tab.activeLegalKey);
  const threadRef = chatTabThreadRef(tab);
  return (
    <ChatTabPanelChrome
      onClose={noop}
      onLabelContextMenu={noop}
      onMoveToMain={noop}
      onStartRename={noop}
      rename={{
        active: false,
        value: tab.label,
        onChange: noop,
        onCommit: noop,
        onCancel: noop,
      }}
      tab={tab}
    >
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-3 pb-32">
          <ChatEmptyState
            onSelectPrompt={noop}
            prompts={decisionPrompts ?? suggestedSkills}
          />
        </ConversationContent>
      </Conversation>

      {/* Same docked geometry (via DockedComposer) the hydrated
          composer uses, so the bar keeps its place when the live panel slots
          in. */}
      <DockedComposer
        bar={<PromptBarPlaceholder tab={tab} />}
        dock={
          <ChatComposerDock
            leadingContext={<ChatMatterPickerPending />}
            status="pending"
            threadRef={threadRef}
          />
        }
      />
    </ChatTabPanelChrome>
  );
};
