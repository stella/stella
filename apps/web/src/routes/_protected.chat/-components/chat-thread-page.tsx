import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  useMutation,
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
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { api } from "@/lib/api";
import {
  getChatSendMode,
  useChatAnonymized,
  useSetChatAnonymized,
} from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useChatWebSearchPreferenceStore } from "@/lib/chat-web-search-store";
import { useDevStore } from "@/lib/dev-store";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { toSafeId } from "@/lib/safe-id";
import { ChatAnonymizedToggle } from "@/routes/_protected.chat/-components/chat-anonymized-toggle";
import { ChatWebSearchToggle } from "@/routes/_protected.chat/-components/chat-web-search-toggle";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
  chatThreadOptions,
  invalidateChatThreadAcrossScopes,
} from "@/routes/_protected.chat/-queries";
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
  const showToolCallDetails = useDevStore((state) => state.showToolCallDetails);
  const prompts = useSavedPrompts();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

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
  if (seededForThreadId !== threadRef.threadId) {
    setSeededForThreadId(threadRef.threadId);
    setContextMatterIds(data.contextMatterIds);
  }

  const {
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
    isLoadingCreateDocumentMatters,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({
    chat,
    conversationId: threadRef.threadId,
    getSendMode,
    workspaceId,
  });
  const sentMessageHistoryHtml = useMemo(
    () => getUserMessageHtmlHistory(messages),
    [messages],
  );

  // Seed brand-new (empty) threads from the persisted web-search
  // preference so the user doesn't have to flip the toggle every time
  // they start a chat. We only fire on the first render where the
  // thread is empty and the prior preference is on; thereafter the
  // per-thread DB row is the source of truth.
  const enabledPreference = useChatWebSearchPreferenceStore(
    (state) => state.enabledPreference,
  );
  const seedWebSearch = useChatWebSearchSeed({ threadRef });
  const seededWebSearchForThreadId = useRef<string | null>(null);
  useEffect(() => {
    if (seededWebSearchForThreadId.current === threadRef.threadId) {
      return;
    }
    if (
      messages.length === 0 &&
      data.webSearchAvailable &&
      !data.webSearchEnabled &&
      enabledPreference
    ) {
      seededWebSearchForThreadId.current = threadRef.threadId;
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
    sentMessageHistoryHtml,
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
        <div className="flex w-full max-w-5xl flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-4 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {threadRef.scope === "workspace" ? (
                <Link
                  className={buttonVariants({
                    variant: "ghost",
                    size: "sm",
                  })}
                  params={{ workspaceId: threadRef.workspaceId }}
                  to="/chat/workspaces/$workspaceId/new"
                >
                  <PlusIcon />
                  {t("chat.newChat")}
                </Link>
              ) : (
                <Link
                  className={buttonVariants({
                    variant: "ghost",
                    size: "sm",
                  })}
                  to="/chat/new"
                >
                  <PlusIcon />
                  {t("chat.newChat")}
                </Link>
              )}
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
            <ConversationContent className="gap-3">
              {messages.length === 0 && !isGenerating && !error ? (
                <div className="m-auto w-full max-w-md px-4">
                  <PromptSuggestions
                    onSelect={selectPrompt}
                    prompts={prompts}
                  />
                </div>
              ) : (
                <ChatThreadMessages
                  approvalPendingMessageId={approvalPendingMessageId}
                  error={error}
                  isGenerating={isGenerating}
                  messages={messages}
                  onAskUserSubmit={handleAskUserSubmit}
                  onCreateDocumentResolve={handleCreateDocumentResolve}
                  onOpenCreatedDocument={handleOpenCreatedDocument}
                  onRemoveQueuedMessage={removeQueuedMessage}
                  onResend={resendLatestMessage}
                  onSendWithoutAnonymization={sendWithoutAnonymization}
                  queuedMessages={queuedMessages}
                  showThinkingIndicator
                  showToolCallDetails={showToolCallDetails}
                  streamdownComponents={streamdownComponents}
                  workspaceId={workspaceId}
                />
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <ChatAnonymizationLayer
            editor={controller.editor}
            enabled={anonymized}
            workspaceId={workspaceId ?? threadRef.threadId}
          />
          <div className="p-4">
            <ChatInputSurface
              anonymized={anonymized}
              autoFocus
              controller={controller}
              isGenerating={isGenerating}
              onStop={() => {
                void stop();
              }}
              onSubmit={async (draft) => {
                if (!(await ensureAIAvailable())) {
                  return;
                }
                await sendMessage(await buildChatRequestMessage(draft));
              }}
            />
          </div>
        </div>
      </ChatApprovalContext>
    </ChatMattersContext>
  );
};

const useChatWebSearchSeed = ({ threadRef }: { threadRef: ChatThreadRef }) => {
  const queryClient = useQueryClient();
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
      return response.data;
    },
    onSuccess: () => {
      void invalidateChatThreadAcrossScopes({
        queryClient,
        threadId: toSafeId<"chatThread">(threadRef.threadId),
      });
    },
  });
  return mutate;
};
