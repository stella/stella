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
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { getUserMessageHtmlHistory } from "@/components/chat/chat-ui-tools";
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
  useSetChatAnonymized,
} from "@/lib/chat-anonymized-store";
import { useIsChatDraftEmpty } from "@/lib/chat-draft-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useChatWebSearchPreferenceStore } from "@/lib/chat-web-search-store";
import { toAPIError } from "@/lib/errors";
import { useModelSelectorStore } from "@/lib/model-selector-store";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { matchReservedChatCommand } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";
import { roleOptions } from "@/routes/-queries";
import { ChatAnonymizedToggle } from "@/routes/_protected.chat/-components/chat-anonymized-toggle";
import { ChatThreadRecap } from "@/routes/_protected.chat/-components/chat-thread-recap";
import { ChatWebSearchToggle } from "@/routes/_protected.chat/-components/chat-web-search-toggle";
import { SuggestedFollowupChips } from "@/routes/_protected.chat/-components/suggested-followup-chips";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
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
  const setAnonymized = useSetChatAnonymized(threadRef);
  const getContextMatterIds = useEffectEvent(() => contextMatterIds ?? []);
  const getSendMode = useEffectEvent(() => getChatSendMode(threadRef));

  const { data } = useSuspenseQuery(
    chatThreadOptions({
      activeOrganizationId,
      key: threadRef,
      // A thread can be opened (e.g. via "Move to main" from the
      // inspector) before its first message has reached the server,
      // so the row may not exist yet. The fetch handles missing
      // threads gracefully; the row is created on first send.
      context: {
        allowMissingThread: true,
        getUserContext,
        getContextMatterIds,
        getSendMode,
      },
    }),
  );
  const { chat } = data;
  useExternalSyncEffect(() => {
    if (seededForThreadId === threadRef.threadId) {
      return;
    }
    setSeededForThreadId(threadRef.threadId);
    setContextMatterIds(data.contextMatterIds);
  }, [data.contextMatterIds, seededForThreadId, threadRef.threadId]);

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
    workspaceId,
  });

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
  const handleUsageLimit = usageLimit.handle;
  // Fire only on the *transition* into a new error. Without this,
  // dismissing the modal would re-trigger the open on the next
  // render (the error reference persists in useChat until the
  // user retries).
  const lastHandledErrorRef = useRef<unknown>(null);
  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- open the usage-limit modal on the transition into a new error. `error` is owned by useChatSession (useChat) and has no setter here; folding this in would require threading the handler into that hook (outside this batch). Keep.
  useEffect(() => {
    if (!error) {
      lastHandledErrorRef.current = null;
      return;
    }
    if (lastHandledErrorRef.current === error) {
      return;
    }
    lastHandledErrorRef.current = error;
    handleUsageLimit(error);
  }, [error, handleUsageLimit]);

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
    reservedCommands: true,
    sentMessageHistoryHtml,
    suggestedFollowupPrompt,
    threadRef,
  });

  const openInspectorChat = useInspectorStore((s) => s.openChat);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
          <div className="bg-background absolute inset-x-0 top-0 z-10 mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-4 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <NewChatButton
                hasMessages={messages.length > 0}
                threadRef={threadRef}
              />
              {contextMatterIds !== null && (
                <ChatMatterPicker
                  matterIds={contextMatterIds}
                  onChange={setContextMatterIds}
                />
              )}
            </div>
            <div className="flex items-center gap-1">
              {data.webSearchAvailable && (
                <ChatWebSearchToggle
                  enabled={data.webSearchEnabled}
                  threadRef={threadRef}
                />
              )}
              <ChatAnonymizedToggle
                enabled={anonymized}
                onChange={setAnonymized}
              />
              <Tooltip
                content={t("chat.moveToSide")}
                render={
                  <Button onClick={moveToSide} size="icon-sm" variant="ghost">
                    <Maximize2Icon className="size-4" />
                  </Button>
                }
              />
              <ThreadsSheet />
            </div>
          </div>

          <Conversation>
            <ConversationContent className="mx-auto w-full max-w-5xl gap-3 px-4 pt-14 pb-36">
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
            <ConversationScrollButton className="bottom-28" />
          </Conversation>

          <ChatAnonymizationLayer
            editor={controller.editor}
            enabled={anonymized}
            workspaceId={workspaceId ?? threadRef.threadId}
          />
          {/* Soft fades so messages dissolve into the floating header and
              composer instead of being clipped at a hard edge. Only when a
              conversation exists — the centered empty-state suggestions
              must stay crisp, not dimmed by the bottom fade. */}
          {messages.length > 0 && (
            <>
              <div
                aria-hidden="true"
                className="from-background pointer-events-none absolute inset-x-0 top-12 mx-auto h-10 w-full max-w-5xl bg-linear-to-b to-transparent"
              />
              <div
                aria-hidden="true"
                className="from-background pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-48 w-full max-w-5xl bg-linear-to-t to-transparent"
              />
            </>
          )}
          <div className="absolute inset-x-0 bottom-0 z-10 mx-auto w-full max-w-5xl px-4 pb-4">
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
            <ChatInputSurface
              anonymized={anonymized}
              autoFocus
              controller={controller}
              isGenerating={isGenerating}
              onStop={() => {
                stop();
              }}
              onSubmit={async (draft) => {
                const reservedCommand = matchReservedChatCommand(draft.html);
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
                await sendMessage(await buildChatRequestMessage(draft));
              }}
            />
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
