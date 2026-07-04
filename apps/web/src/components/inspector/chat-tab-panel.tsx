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

import { useEffect, useEffectEvent } from "react";
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
import { Button } from "@stll/ui/components/button";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  DockedComposer,
  PromptBar,
  PromptBarPlaceholderContent,
  PromptBarShell,
} from "@/components/ai-suggestions/host";
import { useChatEditor } from "@/components/chat-editor-provider";
import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatComposerActionButton } from "@/components/chat/chat-composer-action-button";
import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { PromptSuggestions } from "@/components/chat/prompt-suggestions";
import type { ChatTab } from "@/components/inspector/inspector-store";
import { useInspectorStore } from "@/components/inspector/inspector-store";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import { buildMaximizeTabAction } from "@/components/inspector/maximize-tab";
import { useAIKeyGate } from "@/components/require-ai-key";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { getAnalytics } from "@/lib/analytics/provider";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  getChatSendMode,
  useChatAnonymized,
} from "@/lib/chat-anonymized-store";
import { useIsChatDraftEmpty } from "@/lib/chat-draft-store";
import { type ChatThreadRef, createChatThreadId } from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { useModelSelectorStore } from "@/lib/model-selector-store";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { matchReservedChatCommand } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";
import { SuggestedFollowupChips } from "@/routes/_protected.chat/-components/suggested-followup-chips";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
  chatThreadOptions,
  chatThreadSuggestedPromptsOptions,
} from "@/routes/_protected.chat/-queries";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";

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

const capturePromptSubmitError = (error: unknown): void => {
  getAnalytics().captureError(error);
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
  // useEffectEvent so the chat transport's `getUserContext` is a
  // stable reference across renders (matches legacy chat's pattern
  // — keeps Chat<>'s prepareSendMessagesRequest from re-binding).
  const getUserContext = useEffectEvent(() => userContext);
  // Same pattern for the decision context — it's per-tab metadata
  // that changes only when openChat() is re-invoked, so capturing
  // the current value via useEffectEvent keeps the transport's
  // request shape stable across renders.
  const tabDecisionId = tab.activeDecisionId;
  const getActiveDecision = useEffectEvent(() =>
    tabDecisionId
      ? { decisionId: toSafeId<"caseLawDecision">(tabDecisionId) }
      : undefined,
  );
  const tabActiveSkill = tab.activeSkill;
  const getActiveSkill = useEffectEvent(() => tabActiveSkill);
  const t = useTranslations();
  const { ensureAIAvailable, openIfAIUnavailable } = useAIKeyGate();

  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- opens the AI-gate dialog once the availability query resolves; no single event triggers it (driven by query state across consumers), so there is no handler call-site to fold it into
  useEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

  // Read live tab state on every send. The Chat instance is created
  // once and cached per `threadRef`, so a plain closure over `tab`
  // would freeze the IDs from the render that built the instance —
  // picker updates would land in the store but never reach the
  // server. `useEffectEvent` always reads the latest closure values.
  const getContextMatterIds = useEffectEvent(() => tab.contextMatterIds);
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
  const getSendMode = useEffectEvent(() => getChatSendMode(threadRef));
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const chatContextLabel = useChatContextLabel(tab, activeOrganizationId);

  const { openChat, resetChatTabId, setChatContext, updateLabel } =
    useInspectorStore(
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
  const { data } = useSuspenseQuery(
    chatThreadOptions({
      activeOrganizationId,
      key: threadRef,
      context: {
        allowMissingThread: true,
        getUserContext,
        getActiveDecision,
        ...(tabActiveSkill ? { getActiveSkill } : {}),
        getContextMatterIds,
        getSendMode,
      },
    }),
  );
  const { chat } = data;

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
    isLoadingCreateDocumentMatters,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({
    chat,
    conversationId: threadRef.threadId,
    getSendMode,
    initialOlderCursor: data.olderCursor,
    threadRef,
    workspaceId: tabWorkspaceId,
  });
  const handlePromptSubmit = useEffectEvent(
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
  const lastMessageId = messages.at(-1)?.id ?? null;
  const lastMessageRole = messages.at(-1)?.role ?? null;
  const editorIsInitiallyEmpty = useIsChatDraftEmpty(threadRef);
  // Fetch suggestions only when editor is empty, last message is from
  // assistant, and no generation is in progress. Using draft state
  // avoids triggering the query when user is actively typing.
  const eligibleForSuggestions =
    editorIsInitiallyEmpty &&
    lastMessageId !== null &&
    lastMessageRole === "assistant";
  const { data: suggestedPromptsData } = useQuery(
    chatThreadSuggestedPromptsOptions({
      activeOrganizationId,
      enabled: !isGenerating && eligibleForSuggestions,
      lastMessageId: lastMessageId ?? "",
      threadRef,
    }),
  );
  const suggestedPrompts = suggestedPromptsData?.prompts ?? [];
  const suggestedFollowupPrompt = suggestedPrompts.at(0) ?? undefined;
  const editorController = useChatEditor({
    placeholder: t("chat.contextPlaceholder", { context: chatContextLabel }),
    reservedCommands: true,
    suggestedFollowupPrompt,
    threadRef,
  });
  const focusComposer = editorController.focus;
  const sendWithoutAnonymization = useEffectEvent(async () => {
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

  // Inline rename — same UX as file tabs.
  const labelRename = useInlineRename({
    initial: tab.label,
    onCommit: (value) => {
      updateLabel(tab.id, value);
    },
  });

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
  const pendingRenameTabId = useInspectorStore((s) => s.pendingRenameTabId);
  const clearRenameRequest = useInspectorStore((s) => s.clearRenameRequest);
  const startRenameFromStore = labelRename.startEditing;
  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- store rename-request flag is consumed by multiple tab types (PDF tabs in use-file-tab-rename, chat tabs here) and dispatched generically from the shared context menu; the rename action cannot be folded into the single setter call-site
  useEffect(() => {
    if (pendingRenameTabId === tab.id) {
      startRenameFromStore();
      clearRenameRequest();
    }
  }, [pendingRenameTabId, tab.id, startRenameFromStore, clearRenameRequest]);

  return (
    <ChatMattersContext
      value={{
        createDocumentMatters,
        isLoadingCreateDocumentMatters,
      }}
    >
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
          onStartRename={() => labelRename.startEditing()}
          rename={{
            active: labelRename.state.mode === "edit",
            value:
              labelRename.state.mode === "edit" ? labelRename.state.draft : "",
            onChange: labelRename.setDraft,
            onCommit: () => {
              void labelRename.commit();
            },
            onCancel: labelRename.cancel,
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
                  onLoadOlder={loadOlder}
                  onAskUserSubmit={handleAskUserSubmit}
                  onCreateDocumentResolve={handleCreateDocumentResolve}
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
            <ConversationScrollButton className="bottom-32" />
          </Conversation>

          <ChatAnonymizationLayer
            editor={editorController.editor}
            enabled={anonymized}
            workspaceId={tabWorkspaceId ?? threadRef.threadId}
          />
          {/* PromptBar owns its own docked positioning (via
              DockedComposer): it floats over the transcript, centred and
              pinned to the pane's bottom, identically to the file-overlay
              chat. The chips ride the same one geometry through the
              `followupChips` slot. */}
          <PromptBar
            attachmentsEnabled
            editorController={editorController}
            emptyPlaceholder={
              <PromptBarPlaceholderContent>
                {t("chat.contextPlaceholder", { context: chatContextLabel })}
              </PromptBarPlaceholderContent>
            }
            followupChips={
              <SuggestedFollowupChips
                isGenerating={isGenerating}
                isEmpty={
                  editorController.isEmpty &&
                  editorController.attachments.length === 0
                }
                lastMessageId={messages.at(-1)?.id ?? null}
                lastMessageRole={messages.at(-1)?.role ?? null}
                messageCount={messages.length}
                prompts={suggestedPrompts}
                onSelect={(prompt) => {
                  editorController.setContent(prompt);
                  void editorController.submit(async (draft) => {
                    if (!(await ensureAIAvailable())) {
                      return;
                    }
                    await sendMessage(await buildChatRequestMessage(draft));
                  });
                }}
              />
            }
            layout="standalone"
            onStop={() => {
              stop();
            }}
            onSubmit={({ prompt, files }) => {
              const reservedCommand = matchReservedChatCommand(prompt);
              if (reservedCommand?.id === "new") {
                // Abort any live stream first: rotating the tab id remounts the
                // panel onto a fresh thread while the old Chat would keep
                // streaming in the query cache.
                stop();
                resetChatTabId(tab.id, createChatThreadId());
                editorController.setContent("");
                return;
              }
              if (reservedCommand?.id === "model") {
                editorController.setContent("");
                useModelSelectorStore.getState().open();
                return;
              }

              void handlePromptSubmit({ prompt, files });
            }}
            pendingCount={0}
            queueWhileGenerating
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
                onNewThread={startNewThread}
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
  const actions = (
    <>
      {onMoveToMain && (
        <Tooltip
          content={t("chat.moveToMain")}
          render={
            <Button onClick={onMoveToMain} size="icon-xs" variant="ghost">
              <Maximize2Icon className="size-3.5" />
            </Button>
          }
        />
      )}
    </>
  );

  return (
    <div className="bg-muted/40 relative flex min-w-0 flex-1 flex-col">
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

      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
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
      <div className="flex min-h-8 min-w-0 flex-1 items-center px-1.5">
        <PromptBarPlaceholderContent>
          {t("chat.contextPlaceholder", { context: chatContextLabel })}
        </PromptBarPlaceholderContent>
      </div>
      {/* Same h-8 centering wrapper the live send button uses, so the
          placeholder stays pixel-identical; the disabled action button
          renders the canonical Send look without re-copying its styling. */}
      <span className="flex h-8 shrink-0 items-center">
        <ChatComposerActionButton
          canSend={false}
          isGenerating={false}
          onSend={noop}
        />
      </span>
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
