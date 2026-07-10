import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { Maximize2Icon, PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { Button, buttonVariants } from "@stll/ui/components/button";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { getUserMessageHtmlHistory } from "@/components/chat/chat-ui-tools";
import { ComposerVeil } from "@/components/chat/composer-veil";
import { PromptSuggestions } from "@/components/chat/prompt-suggestions";
import { useAIKeyGate } from "@/components/require-ai-key";
import Tooltip from "@/components/tooltip";
import { UsageLimitModal } from "@/components/usage/usage-limit-modal";
import { useUsageLimit } from "@/components/usage/use-usage-limit";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { api } from "@/lib/api";
import {
  getChatSendMode,
  useChatAnonymized,
} from "@/lib/chat-anonymized-store";
import { useIsChatDraftEmpty } from "@/lib/chat-draft-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useChatWebSearchPreferenceStore } from "@/lib/chat-web-search-store";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { toAPIError } from "@/lib/errors";
import { useModelSelectorStore } from "@/lib/model-selector-store";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { matchReservedChatCommand } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";
import { roleOptions } from "@/routes/-queries";
import { ChatThreadRecap } from "@/routes/_protected.chat/-components/chat-thread-recap";
import { SuggestedFollowupChips } from "@/routes/_protected.chat/-components/suggested-followup-chips";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatModelSelection } from "@/routes/_protected.chat/-hooks/use-chat-model-selection";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatThreadRuntime } from "@/routes/_protected.chat/-hooks/use-chat-thread-runtime";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
  applyChatModelChange,
  chatThreadOptions,
  chatThreadSuggestedPromptsOptions,
  invalidateChatThreadAcrossScopes,
} from "@/routes/_protected.chat/-queries";
import { managementRoles } from "@/routes/_protected.organization/-consts";
import { usageEntitlementOptions } from "@/routes/_protected.settings/-queries/usage";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

type ChatThreadPageProps = {
  threadRef: ChatThreadRef;
  workspaceId?: string | undefined;
};

const protectedRouteApi = getRouteApi("/_protected");

export const ChatThreadPage = ({
  threadRef,
  workspaceId,
}: ChatThreadPageProps) => {
  const t = useTranslations();
  const { ensureAIAvailable } = useAIKeyGate();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const prompts = useSavedPrompts();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  // Entitlement state is manager-only on the server. Skip the query
  // for non-managers so the chat shell doesn't fire a request they
  // can't read; the limit modal's "Manage" CTA is admin-only anyway.
  const { data: currentUserRole } = useQuery({
    ...roleOptions,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const canManageOrganization =
    currentUserRole !== undefined && managementRoles.includes(currentUserRole);

  // Local copy of the persisted contextMatterIds, seeded from the
  // server and re-seeded whenever the page navigates to a different
  // thread. The picker mutates this directly; the transport pulls
  // the latest value via getContextMatterIds on every send, and
  // the server persists the new set on receipt — so we don't need
  // a dedicated PATCH round-trip just to widen scope.
  const [contextMatterIds, setContextMatterIds] = useState<string[] | null>(
    null,
  );
  // Track which thread our local state was seeded for so we can
  // detect navigation between two `/chat/$threadId` routes inside
  // the same mounted component and reset before the next send.
  const [seededForThreadId, setSeededForThreadId] = useState<string | null>(
    null,
  );
  const anonymized = useChatAnonymized(threadRef);
  const getContextMatterIds = useEffectEvent(() => contextMatterIds ?? []);
  const getSendMode = useEffectEvent(() => getChatSendMode(threadRef));

  // A thread can be opened (e.g. via "Move to main" from the inspector)
  // before its first message has reached the server, so the row may not
  // exist yet. The fetch handles missing threads gracefully; the row is
  // created on first send.
  const chatThreadContext = {
    allowMissingThread: true,
    getUserContext,
    getContextMatterIds,
    getSendMode,
  };
  const threadQueryOptions = chatThreadOptions({
    activeOrganizationId,
    key: threadRef,
    context: chatThreadContext,
  });
  const { data } = useSuspenseQuery(threadQueryOptions);
  const chat = useChatThreadRuntime({
    activeOrganizationId,
    context: chatThreadContext,
    data,
    key: threadRef,
  });
  useExternalSyncEffect(() => {
    if (seededForThreadId === threadRef.threadId) {
      return;
    }
    setSeededForThreadId(threadRef.threadId);
    setContextMatterIds(data.contextMatterIds);
  }, [data.contextMatterIds, seededForThreadId, threadRef.threadId]);

  // Surface a 402 usage-limit response from the metered
  // chat handler as a usage-state modal instead of an inline
  // stack trace. `useQuery` (not Suspense) keeps the chat shell
  // rendering while the entitlement state loads.
  const { data: usageEntitlementData } = useQuery({
    ...usageEntitlementOptions({ organizationId: activeOrganizationId }),
    enabled: canManageOrganization,
  });
  const usageLimit = useUsageLimit({
    hasHostedEntitlement:
      usageEntitlementData?.entitlement?.source === "hosted",
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
    onError: usageLimit.handle,
    threadRef,
    workspaceId,
  });

  const sentMessageHistoryHtml = getUserMessageHtmlHistory(messages);

  // Fetch suggested follow-up prompts for Tab-to-ask (editor) and chips display.
  // Gated by draft store emptiness so the query does not fire when the
  // user is already typing a custom follow-up.
  const lastMessage = messages.at(-1);
  const lastMessageId = lastMessage?.id ?? null;
  const lastMessageRole = lastMessage?.role ?? null;
  // Ask-user cards report their local "edit answers" mode here: reopening an
  // answered card turns it back into a live clarification form, which the
  // persisted part state (`output-available`) does not reflect.
  const [editingAskUserToolCallIds, setEditingAskUserToolCallIds] = useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const handleAskUserEditingChange = useCallback(
    (toolCallId: string, isEditing: boolean) => {
      setEditingAskUserToolCallIds((prev) => {
        if (isEditing === prev.has(toolCallId)) {
          return prev;
        }
        const next = new Set(prev);
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
  // An ask-user clarification card owns the turn, and its own questions and
  // submit button take precedence over generic follow-up suggestions, so
  // suppress both the chips and the Tab-to-ask editor hint while one is live.
  // A card is live when it is still awaiting input (always the last message),
  // or when any card has been reopened via Edit — including an earlier card
  // with downstream replies, where the persisted `output-available` state no
  // longer reflects the live edit-and-rerun form.
  const lastMessageHasPendingAskUser =
    lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    lastMessage.parts.some(
      (part) =>
        part.type === "tool-call" &&
        part.name === "ask-user" &&
        part.state !== "complete",
    );
  const askUserOwnsTurn =
    lastMessageHasPendingAskUser || editingAskUserToolCallIds.size > 0;
  const editorIsEmpty = useIsChatDraftEmpty(threadRef);
  const eligibleForSuggestions =
    editorIsEmpty &&
    lastMessageId !== null &&
    lastMessageRole === "assistant" &&
    !askUserOwnsTurn;
  const { data: suggestedPromptsData } = useQuery(
    chatThreadSuggestedPromptsOptions({
      activeOrganizationId,
      enabled: !isGenerating && eligibleForSuggestions,
      lastMessageId: lastMessageId ?? "",
      threadRef,
    }),
  );
  const suggestedFollowupPrompts = suggestedPromptsData?.prompts ?? [];
  const suggestedFollowupPrompt = suggestedFollowupPrompts.at(0) ?? undefined;

  // Seed brand-new (empty) threads from the persisted web-search
  // preference so the user doesn't have to flip the toggle every time
  // they start a chat. We only fire on the first render where the
  // thread is empty and the prior preference is on; thereafter the
  // per-thread DB row is the source of truth.
  const enabledPreference = useChatWebSearchPreferenceStore(
    (state) => state.enabledPreference,
  );
  // Only mark a thread as seeded once the PATCH actually succeeded.
  // The previous version flipped the ref before mutate() resolved,
  // so any transient PATCH failure (network blip, 5xx) permanently
  // suppressed retries for the rest of the session. `inFlight`
  // suppresses duplicate fires while one PATCH is pending.
  const seededWebSearchForThreadId = useRef<string | null>(null);
  const seedingWebSearchForThreadId = useRef<string | null>(null);
  const seedWebSearch = useChatWebSearchSeed({
    threadRef,
    onSettled: (threadId, succeeded) => {
      if (seedingWebSearchForThreadId.current === threadId) {
        seedingWebSearchForThreadId.current = null;
      }
      if (succeeded) {
        seededWebSearchForThreadId.current = threadId;
      }
    },
  });
  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- PATCH-seed the web-search preference once a freshly-opened thread renders empty. The trigger is derived from async query data (data.webSearchAvailable/Enabled) plus store state, not a single setter or a discrete open handler in this file. Keep.
  useEffect(() => {
    if (seededWebSearchForThreadId.current === threadRef.threadId) {
      return;
    }
    if (seedingWebSearchForThreadId.current === threadRef.threadId) {
      return;
    }
    if (
      messages.length === 0 &&
      data.webSearchAvailable &&
      !data.webSearchEnabled &&
      enabledPreference
    ) {
      seedingWebSearchForThreadId.current = threadRef.threadId;
      seedWebSearch();
    }
  }, [
    threadRef.threadId,
    messages.length,
    data.webSearchAvailable,
    data.webSearchEnabled,
    enabledPreference,
    seedWebSearch,
  ]);
  const controller = useChatEditor({
    disableSlashSuggestion: true,
    reservedCommands: true,
    sentMessageHistoryHtml,
    suggestedFollowupPrompt,
    threadRef,
  });

  const openInspectorChat = useInspectorStore((s) => s.openChat);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Persists the composer's Models submenu selection and gates message
  // submit on the outcome (see `onSubmit` below) so a send can never race
  // a just-changed model onto the old, stale one.
  const modelSelection = useChatModelSelection({
    onPersisted: (model) => {
      applyChatModelChange({
        model,
        queryClient,
        queryKey: threadQueryOptions.queryKey,
        threadId: toSafeId<"chatThread">(threadRef.threadId),
      });
    },
    threadRef,
  });

  // "Move to side" — re-host this thread inside the inspector
  // tab. Workspace-scoped chats land on the matter so the pane
  // sits next to its matter content; global chats land on /chat
  // (the thread list) so the inspector pane can mount on a non-
  // workspace route and surface the chat there. Both scopes'
  // caches are invalidated so the inspector doesn't read whichever
  // entry happens to predate the move.
  const moveToSide = () => {
    const persistedContext = contextMatterIds ?? data.contextMatterIds;
    void invalidateChatThreadAcrossScopes({
      queryClient,
      threadId: threadRef.threadId,
    });
    if (threadRef.scope === "workspace") {
      openInspectorChat({
        id: threadRef.threadId,
        workspaceId: threadRef.workspaceId,
        contextMatterIds: persistedContext,
      });
      void navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: threadRef.workspaceId },
      });
      return;
    }
    openInspectorChat({
      id: threadRef.threadId,
      contextMatterIds: persistedContext,
    });
    void navigate({ to: "/chat" });
  };

  const selectPrompt = (prompt: ChatPrompt) => {
    controller.setContent(prompt.body);
    controller.focus();
  };
  const sendWithoutAnonymization = useEffectEvent(async () => {
    await resendLatestMessage({ sendMode: CHAT_SEND_MODE.rawOverride });
  });

  // Dock new-chat: same destination as the header's labeled "New chat"
  // button (which stays as the primary affordance); the dock icon keeps
  // the status row uniform across chat surfaces. Abort any live stream
  // first — `chatThreadOptions` keeps the in-flight Chat alive in the
  // query cache, so navigating away would leave it streaming.
  const startNewThread = () => {
    stop();
    if (threadRef.scope === "workspace") {
      void navigate({
        to: "/chat/workspaces/$workspaceId/new",
        params: { workspaceId: threadRef.workspaceId },
      });
      return;
    }
    void navigate({ to: "/chat/new" });
  };

  // The floating composer block grows with the draft (multi-line text,
  // attachment chips, followup chips), so a static bottom offset cannot
  // keep the scroll-to-bottom button clear of it in every state. Publish
  // the block's live height as a CSS variable on the page container; the
  // button (inside <Conversation>) inherits it and floats just above the
  // block at any composer height.
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const composerBlockRef = useRef<HTMLDivElement>(null);
  useExternalSyncEffect(() => {
    const container = pageContainerRef.current;
    const block = composerBlockRef.current;
    if (container === null || block === null) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      container.style.setProperty(
        "--composer-block-h",
        `${String(block.offsetHeight)}px`,
      );
    });
    observer.observe(block);
    return () => {
      observer.disconnect();
    };
  }, []);

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
        <div className="relative flex w-full flex-1 flex-col overflow-hidden">
          <ChromeHeaderActions>
            <Tooltip
              content={t("chat.moveToSide")}
              render={
                <Button onClick={moveToSide} size="icon-sm" variant="ghost">
                  <Maximize2Icon className="size-4" />
                </Button>
              }
            />
            <ThreadsSheet />
            <NewChatButton
              hasMessages={messages.length > 0}
              threadRef={threadRef}
            />
          </ChromeHeaderActions>

          {/*
            Page-level stacking order (bottom → top):
              1. transcript content   — in-flow, z-auto
              2. sticky user headers  — z-10 (capped inside <Conversation>)
              3. scroll-to-bottom btn — z-10, painted after the headers
              4. fade gradient        — z-auto sibling, above the isolated
                                        <Conversation> stacking context
              5. composer             — z-20, floats above everything
            `isolate` on <Conversation> traps every transcript stacking
            value (sticky headers, scroll button) inside its own context so
            none of them can leak up and overlay the fade or the composer.
          */}
          <div
            className="relative flex min-h-0 flex-1 flex-col"
            ref={pageContainerRef}
          >
            <Conversation className="isolate min-h-0">
              <ConversationContent className="mx-auto w-full max-w-5xl gap-3 px-4 pb-36">
                {messages.length === 0 && !isGenerating && !error ? (
                  <div className="m-auto w-full max-w-md px-4">
                    <PromptSuggestions
                      onSelect={selectPrompt}
                      prompts={prompts}
                    />
                  </div>
                ) : (
                  <>
                    <ChatThreadMessages
                      approvalPendingMessageId={approvalPendingMessageId}
                      error={error}
                      hasOlderMessages={olderCursor !== null}
                      isGenerating={isGenerating}
                      isLoadingOlder={isLoadingOlder}
                      loadOlderError={loadOlderError}
                      messages={messages}
                      onLoadOlder={loadOlder}
                      onAskUserEditAndRerun={handleAskUserEditAndRerun}
                      onAskUserEditingChange={handleAskUserEditingChange}
                      onAskUserSubmit={handleAskUserSubmit}
                      onCreateDocumentResolve={handleCreateDocumentResolve}
                      onOpenCreatedDocument={handleOpenCreatedDocument}
                      onRemoveQueuedMessage={removeQueuedMessage}
                      onResend={resendLatestMessage}
                      onSendWithoutAnonymization={sendWithoutAnonymization}
                      queuedMessages={queuedMessages}
                      showThinkingIndicator
                      stickyUserMessages
                      streamdownComponents={streamdownComponents}
                      workspaceId={workspaceId}
                    />
                    <ChatThreadRecap
                      activeOrganizationId={activeOrganizationId}
                      isGenerating={isGenerating}
                      key={threadRef.threadId}
                      lastActivityAt={data.lastActivityAt}
                      lastMessageId={messages.at(-1)?.id ?? null}
                      lastMessageRole={messages.at(-1)?.role ?? null}
                      messageCount={messages.length}
                      threadRef={threadRef}
                    />
                  </>
                )}
              </ConversationContent>
              <ConversationScrollButton className="bottom-[calc(var(--composer-block-h,7rem)+0.75rem)]" />
            </Conversation>

            <ChatAnonymizationLayer
              editor={controller.editor}
              enabled={anonymized}
              workspaceId={workspaceId ?? threadRef.threadId}
            />
            {/* Soft fade so messages dissolve into the floating composer
              instead of being clipped at a hard edge. Only when a
              conversation exists — the centered empty-state suggestions
              must stay crisp, not dimmed by the bottom fade. */}
            {messages.length > 0 && (
              <div
                aria-hidden="true"
                className="from-background pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-48 w-full max-w-5xl bg-linear-to-t to-transparent"
              />
            )}
            {/* Top of the page stacking order: must stack above the sticky
                transcript headers and the fade gradient. `z-20` beats the
                isolated <Conversation> context (which caps its sticky
                headers at z-10) and the z-auto fade sibling.

                No bottom padding: the composer block hugs the pane bottom so
                the glass veil (the shared `ComposerVeil` behind the tray)
                reaches the bottom edge with no unblurred strip of transcript
                showing through beneath the status row. The tray wrapper's
                `p-2` keeps the composer breathing inside the veil.
                `--composer-block-h` is measured from this block's live
                height, so the scroll button's offset tracks the change
                automatically. */}
            <div
              className="absolute inset-x-0 bottom-0 z-20 mx-auto w-full max-w-5xl px-4"
              ref={composerBlockRef}
            >
              <SuggestedFollowupChips
                isGenerating={isGenerating}
                isEmpty={
                  controller.isEmpty && controller.attachments.length === 0
                }
                lastMessageId={messages.at(-1)?.id ?? null}
                lastMessageRole={messages.at(-1)?.role ?? null}
                messageCount={messages.length}
                prompts={suggestedFollowupPrompts}
                onSelect={(prompt) => {
                  controller.setContent(prompt);
                  void controller.submit(async (draft) => {
                    if (!(await ensureAIAvailable())) {
                      return;
                    }
                    await sendMessage(await buildChatRequestMessage(draft));
                  });
                }}
              />
              {/* Glass tray behind the composer + status row: the shared
                  `ComposerVeil` (one owner of the blur/tint values across
                  every chat surface) fills this `relative isolate` wrapper
                  so the floating status-row text stays readable over the
                  scrolled transcript. */}
              <div className="relative isolate p-2">
                <ComposerVeil />
                <ChatInputSurface
                  anonymized={anonymized}
                  autoFocus
                  context={{ activeOrganizationId, threadRef }}
                  controller={controller}
                  isGenerating={isGenerating}
                  mcpOrganizationId={activeOrganizationId}
                  models={{
                    activeOrganizationId,
                    threadRef,
                    selectedModel: data.model,
                    selectModel: modelSelection.selectModel,
                  }}
                  skillsOrganizationId={activeOrganizationId}
                  dock={
                    <ChatComposerDock
                      data={data}
                      leadingContext={
                        contextMatterIds !== null ? (
                          <ChatMatterPicker
                            matterIds={contextMatterIds}
                            onChange={setContextMatterIds}
                          />
                        ) : undefined
                      }
                      onNewThread={messages.length > 0 ? startNewThread : null}
                      threadRef={threadRef}
                    />
                  }
                  onStop={() => {
                    stop();
                  }}
                  onSubmit={async (draft) => {
                    const reservedCommand = matchReservedChatCommand(
                      draft.html,
                    );
                    if (reservedCommand?.id === "new") {
                      // Abort any live stream first: `chatThreadOptions` keeps the
                      // in-flight Chat alive in the query cache, so navigating away
                      // would leave it streaming against the abandoned thread.
                      stop();
                      controller.setContent("");
                      if (threadRef.scope === "workspace") {
                        void navigate({
                          to: "/chat/workspaces/$workspaceId/new",
                          params: { workspaceId: threadRef.workspaceId },
                          replace: true,
                        });
                      } else {
                        void navigate({
                          to: "/chat/new",
                          replace: true,
                        });
                      }
                      return;
                    }
                    if (reservedCommand?.id === "model") {
                      controller.setContent("");
                      useModelSelectorStore.getState().open();
                      return;
                    }

                    if (!(await ensureAIAvailable())) {
                      return;
                    }
                    // A model just picked in the (+) menu may still be
                    // mid-PATCH: wait for it to settle so the send can
                    // never race onto the thread's previous model. On
                    // failure the hook has already toasted; abort instead
                    // of sending with a model that may not match what the
                    // server has persisted.
                    if (
                      Result.isError(
                        await modelSelection.awaitPendingSelection(),
                      )
                    ) {
                      return;
                    }
                    await sendMessage(await buildChatRequestMessage(draft));
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </ChatApprovalContext>
      <UsageLimitModal
        {...usageLimit.modalProps}
        hasHostedEntitlement={usageLimit.hasHostedEntitlement}
      />
    </ChatMattersContext>
  );
};

type ChatWebSearchSeedProps = {
  threadRef: ChatThreadRef;
  /**
   * Invoked after the PATCH settles regardless of outcome. Lets the
   * caller advance its bookkeeping refs (mark thread seeded only on
   * `succeeded === true`; clear the in-flight ref either way). The
   * threadId is echoed so callers can guard against stale settlements
   * after the user navigated to a different thread.
   */
  onSettled: (threadId: string, succeeded: boolean) => void;
};

const useChatWebSearchSeed = ({
  threadRef,
  onSettled,
}: ChatWebSearchSeedProps) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const { mutate } = useMutation({
    mutationFn: async () => {
      const response = await api.chat
        .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
        .patch(
          { webSearchEnabled: true },
          {
            query:
              threadRef.scope === "workspace"
                ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
                : {},
          },
        );
      // Eden returns `{ error }` on non-2xx responses; without this
      // throw onSuccess fires and the thread is marked seeded for
      // the session, leaving web search silently off.
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      void invalidateChatThreadAcrossScopes({
        queryClient,
        threadId: toSafeId<"chatThread">(threadRef.threadId),
      });
      onSettled(threadRef.threadId, true);
    },
    onError: (error) => {
      analytics.captureError(error);
      onSettled(threadRef.threadId, false);
    },
  });
  return mutate;
};

const NewChatButton = ({
  hasMessages,
  threadRef,
}: {
  hasMessages: boolean;
  threadRef: ChatThreadRef;
}) => {
  const t = useTranslations();
  // Empty draft? Stay put. Otherwise spawn a fresh thread via the
  // /chat/new (or workspace-scoped) redirect helper.
  if (!hasMessages) {
    return (
      <Button disabled size="sm" variant="ghost">
        <PlusIcon />
        {t("chat.newChat")}
      </Button>
    );
  }
  if (threadRef.scope === "workspace") {
    return (
      <Link
        className={buttonVariants({ variant: "ghost", size: "sm" })}
        params={{ workspaceId: threadRef.workspaceId }}
        to="/chat/workspaces/$workspaceId/new"
      >
        <PlusIcon />
        {t("chat.newChat")}
      </Link>
    );
  }
  return (
    <Link
      className={buttonVariants({ variant: "ghost", size: "sm" })}
      to="/chat/new"
    >
      <PlusIcon />
      {t("chat.newChat")}
    </Link>
  );
};
