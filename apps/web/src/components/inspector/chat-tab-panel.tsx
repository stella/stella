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

import { useCallback, useRef, useState } from "react";
import type { MouseEvent } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2Icon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { Button } from "@stll/ui/button";
import { COMPOSER_COMPACT_TEXT_CELL_CLASS } from "@stll/ui/composer";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationScrollProvider,
} from "@/components/ai-elements/conversation";
import {
  DockedComposer,
  PromptBar,
  PromptBarPlaceholderContent,
  PromptBarShell,
} from "@/components/ai-suggestions/host";
import {
  ChatSubmitPreservedError,
  useChatEditor,
} from "@/components/chat-editor-provider";
import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatComposerActionButton } from "@/components/chat/chat-composer-action-button";
import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { ComposerControlSlot } from "@/components/chat/composer-control-slot";
import { PromptSuggestions } from "@/components/chat/prompt-suggestions";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { ChatTab } from "@/components/inspector/inspector-tabs-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { buildMaximizeTabAction } from "@/components/inspector/maximize-tab";
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
import { buildChatRequestMessage } from "@/features/chat/lib/build-chat-request-message";
import { startNewThreadCommandHandoff } from "@/features/chat/lib/start-new-thread-command-handoff";
import {
  resolveSuggestedPromptsAvailability,
  resolveSuggestedPromptsTurnOwner,
} from "@/features/chat/lib/suggested-prompts-availability";
import {
  chatThreadOptions,
  chatThreadSuggestedPromptsOptions,
} from "@/features/chat/queries";
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
import { useIsChatDraftEmpty } from "@/lib/chat-draft-store";
import {
  createChatThreadId,
  getChatThreadKey,
  type ChatThreadRef,
} from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { detached } from "@/lib/detached";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { runReservedChatCommand } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

type ChatTabPanelProps = {
  tab: ChatTab;
  onClose: () => void;
  onLabelContextMenu: (event: MouseEvent<HTMLElement>) => void;
  /**
   * Resolved matter colour from the inspector's workspace context,
   * passed straight through to the tab header so the chat tab
   * picks up the same breadcrumb tint as the rest of the matter.
   */
  matterColor?: string | null | undefined;
};

export const ChatTabPanel = ({
  tab,
  onClose,
  onLabelContextMenu,
  matterColor,
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
  // Same pattern for the decision context — it's per-tab metadata
  // that changes only when openChat() is re-invoked, so capturing
  // the current value via useLatestCallback keeps the transport's
  // request shape stable across renders.
  const tabDecisionId = tab.activeDecisionId;
  const getActiveDecision = useLatestCallback(() =>
    tabDecisionId
      ? { decisionId: toSafeId<"caseLawDecision">(tabDecisionId) }
      : undefined,
  );
  const tabActiveSkill = tab.activeSkill;
  const getActiveSkill = useLatestCallback(() => tabActiveSkill);
  const t = useTranslations();
  const capturePromptSubmitError = useCallback(
    (error: unknown): void => {
      if (ChatSubmitPreservedError.is(error)) {
        return;
      }
      getAnalytics().captureError(error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
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
  const threadRef: ChatThreadRef =
    tabWorkspaceId === undefined
      ? {
          scope: "global",
          // tab.id is already a UUID generated by openChat() —
          // backend validates as SafeId<"chatThread"> so we pass
          // it bare (no prefix).
          threadId: tab.id,
        }
      : {
          scope: "workspace",
          threadId: tab.id,
          workspaceId: tabWorkspaceId,
        };
  // Display and send read one shared per-thread send-mode source: the
  // dock's shield renders `useChatAnonymized(threadRef)` while the
  // transport's `getSendMode` reads `getChatSendMode(threadRef)` — the
  // same store — so the shield can never show a state the next request
  // won't honour.
  const anonymized = useChatAnonymized(threadRef);
  const [composerFocused, setComposerFocused] = useState(false);
  const getSendMode = useLatestCallback(() => getChatSendMode(threadRef));
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const chatContextLabel = useChatContextLabel(tab, activeOrganizationId);

  const { openChat, resetChatTabId, setChatContext, updateLabel } =
    useInspectorTabsStore(
      useShallow((s) => ({
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
    getActiveDecision,
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
    isLoadingCreateDocumentMatters,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({
    chat,
    conversationId: threadRef.threadId,
    getContextMatterIds,
    getSendMode,
    initialOlderCursor: data.olderCursor,
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
    }) => {
      try {
        if (!(await ensureAIAvailable())) {
          return;
        }

        // PromptBar emits the raw editor HTML; the backend parses
        // `<entity-mention>` tags out of TanStack text content.
        await sendMessage(
          await buildChatRequestMessage({ files, html: prompt }),
        );
      } catch (submitError) {
        capturePromptSubmitError(submitError);
      }
    },
  );

  // TipTap composer for this thread — `@`-mention chips, drafts,
  // attachments come from the same provider as the right-panel
  // chat. Thread ref is shared with `chatThreadOptions` above so
  // drafts persist across tab close/open.
  const lastMessage = messages.at(-1);
  const [editingAskUserToolCallIds, setEditingAskUserToolCallIds] = useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const handleAskUserEditingChange = useCallback(
    (toolCallId: string, isEditing: boolean) => {
      setEditingAskUserToolCallIds((current) => {
        if (current.has(toolCallId) === isEditing) {
          return current;
        }
        const next = new Set(current);
        if (isEditing) {
          next.add(toolCallId);
        } else {
          next.delete(toolCallId);
        }
        return next;
      });
    },
    [],
  );
  const editorIsInitiallyEmpty = useIsChatDraftEmpty(threadRef);
  // Fetch suggestions only when editor is empty, last message is from
  // assistant, and no generation is in progress. Using draft state
  // avoids triggering the query when user is actively typing.
  const suggestedPromptsAvailability = resolveSuggestedPromptsAvailability({
    editorIsEmpty: editorIsInitiallyEmpty,
    error,
    isGenerating,
    lastMessage: lastMessage ?? null,
    turnAbandoned,
    turnOwner: resolveSuggestedPromptsTurnOwner({
      approvalPendingMessageId,
      hasReopenedAskUser: editingAskUserToolCallIds.size > 0,
      lastMessage: lastMessage ?? null,
    }),
  });
  const lastMessageId =
    suggestedPromptsAvailability.status === "eligible"
      ? suggestedPromptsAvailability.lastMessageId
      : "";
  const { data: suggestedPromptsData } = useQuery(
    chatThreadSuggestedPromptsOptions({
      activeOrganizationId,
      enabled: suggestedPromptsAvailability.status === "eligible",
      lastMessageId,
      threadRef,
    }),
  );
  const suggestedPrompts =
    suggestedPromptsAvailability.status === "eligible" && suggestedPromptsData
      ? suggestedPromptsData.prompts
      : [];
  const suggestedFollowupPrompt = suggestedPrompts.at(0) ?? undefined;
  const editorController = useChatEditor({
    placeholder: t("chat.contextPlaceholder", { context: chatContextLabel }),
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

  const savedPrompts = useSavedPrompts();
  const handleSelectPrompt = (prompt: ChatPrompt) => {
    editorController.setContent(prompt.body);
    editorController.focus();
  };

  // Inline rename — same UX as file tabs, plus a write-through to the
  // persisted conversation title once the thread has messages. Without the
  // write-through, renaming a docked chat would change only the local tab
  // label while the real conversation title stayed stale on every other
  // surface. Pre-first-message renames stay label-only, as before.
  const renameThread = useRenameChatThread(threadRef);
  const hasThreadMessages = messages.length > 0;
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
  // pane header: opens a fresh tab with the same scope + context.
  const startNewThread = () => {
    openChat({
      workspaceId: tabWorkspaceId,
      contextMatterIds: tab.contextMatterIds,
      ...(tab.activeDecisionId
        ? { activeDecisionId: tab.activeDecisionId }
        : {}),
      ...(tab.activeSkill ? { activeSkill: tab.activeSkill } : {}),
    });
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

  const handleComposerSubmit = useLatestCallback(
    async ({
      prompt,
      files,
    }: {
      prompt: string;
      files: ChatDraftAttachment[];
    }) => {
      const newThreadMessages: string[] = [];
      const handledReserved = runReservedChatCommand(prompt, {
        new: (args) => {
          if (args.length > 0) {
            newThreadMessages.push(args);
            return;
          }
          stop();
          resetChatTabId(tab.id, createChatThreadId());
          editorController.setContent("");
        },
        "rename-chat": (args) => {
          editorController.setContent("");
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
        await handlePromptSubmit({ prompt, files });
        return;
      }

      const newThreadMessage = newThreadMessages.at(0);
      if (newThreadMessage === undefined) {
        return;
      }
      if (!(await ensureAIAvailable())) {
        throw new ChatSubmitPreservedError({ message: "AI is unavailable" });
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
      stop();
      resetChatTabId(tab.id, newThreadId);
    },
  );

  return (
    <ChatMattersContext
      value={{
        createDocumentMatters,
        isLoadingCreateDocumentMatters,
      }}
    >
      <AIUnavailableDialogTrigger />
      <ChatApprovalContext
        value={{
          activeOrganizationId,
          alwaysApprovedTools,
          conversationApprovedTools,
          handleAllowInConversation,
          handleAlwaysAllow,
          handleApprove,
          handleDeny,
        }}
      >
        <ChatTabPanelChrome
          matterColor={matterColor}
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
                floating composer block (veil + pill + status row). */}
            <ConversationContent className="gap-3 pb-32">
              {messages.length === 0 && !isGenerating && !error ? (
                <ChatEmptyState
                  onSelectPrompt={handleSelectPrompt}
                  prompts={savedPrompts}
                />
              ) : (
                <ChatThreadMessages
                  approvalPendingMessageId={approvalPendingMessageId}
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
                  onRemoveQueuedMessage={removeQueuedMessage}
                  onResend={resendLatestMessage}
                  onSendWithoutAnonymization={sendWithoutAnonymization}
                  queuedMessages={queuedMessages}
                  showThinkingIndicator
                  streamdownComponents={streamdownComponents}
                  workspaceId={tabWorkspaceId}
                />
              )}
            </ConversationContent>
            {/* Clear the floating composer block (veil + pill + row). */}
            <ConversationScrollButton
              className={cn("bottom-32", hasSuggestedFollowups && "hidden")}
            />
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
            editorController={editorController}
            emptyPlaceholder={
              <PromptBarPlaceholderContent>
                {t("chat.contextPlaceholder", { context: chatContextLabel })}
              </PromptBarPlaceholderContent>
            }
            followupChips={
              <SuggestedFollowupChips
                onSelect={(prompt) => {
                  editorController.setContent(prompt);
                  detached(
                    editorController.submit(async (draft) => {
                      if (!(await ensureAIAvailable())) {
                        return;
                      }
                      await sendMessage(await buildChatRequestMessage(draft));
                    }),
                    "chat-tab-panel.submit",
                  );
                }}
                prompts={suggestedPrompts}
              />
            }
            layout="standalone"
            onFocusChange={setComposerFocused}
            onSubmitError={capturePromptSubmitError}
            onStop={() => {
              stop();
            }}
            onSubmit={handleComposerSubmit}
            pendingCount={0}
            queueWhileGenerating
            reservedCommands={{ hasPersistedThread: hasThreadMessages }}
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
                threadRef={threadRef}
              />
            }
          />
        </ChatTabPanelChrome>
      </ChatApprovalContext>
    </ChatMattersContext>
  );
};

const useChatContextLabel = (tab: ChatTab, activeOrganizationId: string) => {
  const t = useTranslations();
  const { data } = useQuery(workspacesNavigationOptions(activeOrganizationId));
  const resolvedLabel = isPlaceholderThreadTitle(tab.label)
    ? t("chat.newChat")
    : tab.label;
  const fallbackLabel =
    resolvedLabel.trim().length > 0 ? resolvedLabel : "chat";

  if (tab.activeSkill) {
    return tab.activeSkill.skillName;
  }

  const workspaces = data?.workspaces;
  if (workspaces === undefined || tab.contextMatterIds.length === 0) {
    return fallbackLabel;
  }

  const selectedNames = tab.contextMatterIds
    .map((id) => workspaces.find((workspace) => workspace.id === id)?.name)
    .filter((name): name is string => name !== undefined);

  const firstName = selectedNames.at(0);
  if (firstName === undefined) {
    return fallbackLabel;
  }

  if (selectedNames.length === 1) {
    return firstName;
  }

  return `${firstName} +${String(selectedNames.length - 1)}`;
};

type ChatEmptyStateProps = {
  prompts: ChatPrompt[];
  onSelectPrompt: (prompt: ChatPrompt) => void;
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
  matterColor?: string | null | undefined;
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
  matterColor,
  children,
}: ChatTabPanelChromeProps) => {
  const t = useTranslations();
  // New-chat is not a header action: it lives in the composer's status
  // row (`ChatComposerDock`), uniform with every other chat surface.
  const actions = onMoveToMain && (
    <Tooltip
      content={t("chat.moveToMain")}
      render={
        <Button onClick={onMoveToMain} size="icon-xs" variant="ghost">
          <Maximize2Icon className="size-3.5" />
        </Button>
      }
    />
  );

  return (
    <div
      className="bg-muted/40 relative flex min-w-0 flex-1 flex-col"
      data-slot="inspector-chat-panel"
    >
      <InspectorTabHeader
        actions={actions}
        label={
          isPlaceholderThreadTitle(tab.label) ? t("chat.newChat") : tab.label
        }
        matterColor={matterColor}
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
  const chatContextLabel = useChatContextLabel(tab, activeOrganizationId);
  return (
    <PromptBarShell aria-hidden="true">
      <div
        className={cn(
          COMPOSER_COMPACT_TEXT_CELL_CLASS,
          "flex flex-1 items-center px-1.5",
        )}
      >
        <PromptBarPlaceholderContent>
          {t("chat.contextPlaceholder", { context: chatContextLabel })}
        </PromptBarPlaceholderContent>
      </div>
      {/* Same control slot the live send button uses, so the placeholder
          stays pixel-identical; the disabled action button renders the
          canonical Send look without re-copying its styling. */}
      <ComposerControlSlot>
        <ChatComposerActionButton
          canSend={false}
          isGenerating={false}
          onSend={noop}
        />
      </ComposerControlSlot>
    </PromptBarShell>
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
export const ChatTabPanelShell = ({
  tab,
  matterColor,
}: {
  tab: ChatTab;
  matterColor?: string | null | undefined;
}) => {
  const savedPrompts = useSavedPrompts();
  return (
    <ChatTabPanelChrome
      matterColor={matterColor}
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
          <ChatEmptyState onSelectPrompt={noop} prompts={savedPrompts} />
        </ConversationContent>
      </Conversation>

      {/* Same docked geometry (via DockedComposer) the hydrated
          composer uses, so the bar keeps its place when the live panel slots
          in. */}
      <DockedComposer bar={<PromptBarPlaceholder tab={tab} />} />
    </ChatTabPanelChrome>
  );
};
