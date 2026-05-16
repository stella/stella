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

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { MouseEvent } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { ArrowUpIcon, Maximize2Icon, SquarePenIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { CHAT_SEND_MODE, getPreferredChatSendMode } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import { Button } from "@stll/ui/components/button";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptBar,
  PromptBarPlaceholderContent,
  PromptBarShell,
} from "@/components/ai-suggestions/host";
import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { PromptSuggestions } from "@/components/chat/prompt-suggestions";
import { useAIKeyGate } from "@/components/require-ai-key";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useDevStore } from "@/lib/dev-store";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { toSafeId } from "@/lib/safe-id";
import { ChatAnonymizedToggle } from "@/routes/_protected.chat/-components/chat-anonymized-toggle";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { chatThreadOptions } from "@/routes/_protected.chat/-queries";
import type { ChatTab } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { InspectorTabHeader } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-tab-header";
import { buildMaximizeTabAction } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/maximize-tab";
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
  const t = useTranslations();
  const { ensureAIAvailable, openIfAIUnavailable } = useAIKeyGate();

  useEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

  // Read live tab state on every send. The Chat instance is created
  // once and cached per `threadRef`, so a plain closure over `tab`
  // would freeze the IDs from the render that built the instance —
  // picker updates would land in the store but never reach the
  // server. `useEffectEvent` always reads the latest closure values.
  const getContextMatterIds = useEffectEvent(() => tab.contextMatterIds);
  const [sendMode, setSendMode] = useState<ChatSendMode>(
    CHAT_SEND_MODE.rawOverride,
  );
  const anonymized = sendMode === CHAT_SEND_MODE.anonymized;
  const setAnonymized = (enabled: boolean) => {
    setSendMode(getPreferredChatSendMode(enabled));
  };
  const getSendMode = useEffectEvent(() => sendMode);
  const showToolCallDetails = useDevStore((s) => s.showToolCallDetails);
  const chatContextLabel = useChatContextLabel(tab);

  const { openChat, setChatContext, updateLabel } = useInspectorStore(
    useShallow((s) => ({
      openChat: s.openChat,
      setChatContext: s.setChatContext,
      updateLabel: s.updateLabel,
    })),
  );
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const moveToMain = buildMaximizeTabAction(tab, {
    activeOrganizationId,
    navigate,
    queryClient,
  });

  const threadRef = useMemo<ChatThreadRef>(
    () =>
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
          },
    [tab.id, tabWorkspaceId],
  );

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
        getContextMatterIds,
        getSendMode,
      },
    }),
  );
  const { chat } = data;

  const {
    error,
    messages,
    resendLatestMessage,
    sendMessage,
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
    isLoadingCreateDocumentMatters,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({
    chat,
    conversationId: threadRef.threadId,
    workspaceId: tabWorkspaceId,
  });

  // TipTap composer for this thread — `@`-mention chips, drafts,
  // attachments come from the same provider as the right-panel
  // chat. Thread ref is shared with `chatThreadOptions` above so
  // drafts persist across tab close/open.
  const editorController = useChatEditor({
    placeholder: t("chat.contextPlaceholder", { context: chatContextLabel }),
    threadRef,
  });
  const focusComposer = editorController.focus;
  const sendWithoutAnonymization = useEffectEvent(async () => {
    await resendLatestMessage({ sendMode: CHAT_SEND_MODE.rawOverride });
  });

  useEffect(() => {
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

  // The shared tab context menu (right-click on rail icon or
  // ribbon label) dispatches `requestRename(tabId)` to the store.
  // PDF tabs read that flag in InspectorPanel; chat tabs own their
  // rename state locally so they consume the flag here.
  const pendingRenameTabId = useInspectorStore((s) => s.pendingRenameTabId);
  const clearRenameRequest = useInspectorStore((s) => s.clearRenameRequest);
  const startRenameFromStore = labelRename.startEditing;
  useEffect(() => {
    if (pendingRenameTabId === tab.id) {
      startRenameFromStore();
      clearRenameRequest();
    }
  }, [pendingRenameTabId, tab.id, startRenameFromStore, clearRenameRequest]);

  return (
    <ChatTabPanelChrome
      matterColor={matterColor}
      onClose={onClose}
      onLabelContextMenu={onLabelContextMenu}
      onMoveToMain={moveToMain}
      anonymized={anonymized}
      onNewThread={() =>
        openChat({
          workspaceId: tabWorkspaceId,
          contextMatterIds: tab.contextMatterIds,
          ...(tab.activeDecisionId
            ? { activeDecisionId: tab.activeDecisionId }
            : {}),
        })
      }
      onSetAnonymized={setAnonymized}
      onSetContext={(next) => setChatContext(tab.id, next)}
      onStartRename={labelRename.startEditing}
      rename={{
        active: labelRename.state.mode === "edit",
        value: labelRename.state.mode === "edit" ? labelRename.state.draft : "",
        onChange: labelRename.setDraft,
        onCommit: () => {
          void labelRename.commit();
        },
        onCancel: labelRename.cancel,
      }}
      tab={tab}
    >
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-3">
          {messages.length === 0 && !isGenerating && !error ? (
            <ChatEmptyState
              onSelectPrompt={handleSelectPrompt}
              prompts={savedPrompts}
            />
          ) : (
            <ChatThreadMessages
              activeOrganizationId={activeOrganizationId}
              alwaysApprovedTools={alwaysApprovedTools}
              approvalPendingMessageId={approvalPendingMessageId}
              conversationApprovedTools={conversationApprovedTools}
              error={error}
              handleAllowInConversation={handleAllowInConversation}
              handleAlwaysAllow={handleAlwaysAllow}
              handleApprove={handleApprove}
              handleDeny={handleDeny}
              isGenerating={isGenerating}
              messages={messages}
              onAskUserSubmit={handleAskUserSubmit}
              onCreateDocumentResolve={handleCreateDocumentResolve}
              onOpenCreatedDocument={handleOpenCreatedDocument}
              createDocumentMatters={createDocumentMatters}
              isLoadingCreateDocumentMatters={isLoadingCreateDocumentMatters}
              onResend={resendLatestMessage}
              onSendWithoutAnonymization={sendWithoutAnonymization}
              showThinkingIndicator
              showToolCallDetails={showToolCallDetails}
              streamdownComponents={streamdownComponents}
              workspaceId={tabWorkspaceId}
            />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <ChatAnonymizationLayer
        editor={editorController.editor}
        enabled={anonymized}
        workspaceId={tabWorkspaceId ?? threadRef.threadId}
      />
      <PromptBar
        editorController={editorController}
        emptyPlaceholder={
          <PromptBarPlaceholderContent>
            {t("chat.contextPlaceholder", { context: chatContextLabel })}
          </PromptBarPlaceholderContent>
        }
        layout="standalone"
        onStop={() => {
          void stop();
        }}
        onSubmit={({ prompt }) => {
          void ensureAIAvailable().then((available) => {
            if (!available) {
              return;
            }
            // PromptBar emits the raw editor HTML; the legacy
            // backend already parses `<entity-mention>` tags out
            // of the `text` field, so we forward unchanged.
            void sendMessage({ text: prompt });
          });
        }}
        onTogglePanel={() => {
          // Standalone has no thread toggle; never called.
        }}
        panelOpen={false}
        pendingCount={0}
        showThreadToggle={false}
        status={isGenerating ? "generating" : "idle"}
      />
    </ChatTabPanelChrome>
  );
};

const useChatContextLabel = (tab: ChatTab) => {
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data } = useQuery(workspacesNavigationOptions(activeOrganizationId));
  const fallbackLabel = tab.label.trim().length > 0 ? tab.label : "chat";

  return useMemo(() => {
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
  }, [data?.workspaces, fallbackLabel, tab.contextMatterIds]);
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
  anonymized: boolean;
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
  onNewThread?: (() => void) | undefined;
  onSetAnonymized: (enabled: boolean) => void;
  onSetContext: (matterIds: string[]) => void;
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
  anonymized,
  tab,
  onClose,
  onLabelContextMenu,
  onStartRename,
  rename,
  onMoveToMain,
  onNewThread,
  onSetAnonymized,
  onSetContext,
  matterColor,
  children,
}: ChatTabPanelChromeProps) => {
  const t = useTranslations();
  const actions = (
    <>
      {onNewThread && (
        <Tooltip
          content={t("chat.newChat")}
          render={
            <Button onClick={onNewThread} size="icon-xs" variant="ghost">
              <SquarePenIcon className="size-3.5" />
            </Button>
          }
        />
      )}
      <ChatAnonymizedToggle
        enabled={anonymized}
        onChange={onSetAnonymized}
        size="icon-xs"
      />
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
        label={tab.label}
        matter={
          <ChatMatterPicker
            matterIds={tab.contextMatterIds}
            onChange={onSetContext}
          />
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
  const chatContextLabel = useChatContextLabel(tab);
  return (
    <PromptBarShell aria-hidden="true" layout="standalone">
      <div className="flex min-h-8 min-w-0 flex-1 items-center px-1.5">
        <PromptBarPlaceholderContent>
          {t("chat.contextPlaceholder", { context: chatContextLabel })}
        </PromptBarPlaceholderContent>
      </div>
      <Button className="rounded-full" disabled size="icon" type="button">
        <ArrowUpIcon aria-hidden="true" />
      </Button>
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
      anonymized={false}
      matterColor={matterColor}
      onClose={noop}
      onLabelContextMenu={noop}
      onMoveToMain={noop}
      onNewThread={noop}
      onSetAnonymized={noop}
      onSetContext={noop}
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
        <ConversationContent className="gap-3">
          <ChatEmptyState onSelectPrompt={noop} prompts={savedPrompts} />
        </ConversationContent>
      </Conversation>

      <PromptBarPlaceholder tab={tab} />
    </ChatTabPanelChrome>
  );
};
