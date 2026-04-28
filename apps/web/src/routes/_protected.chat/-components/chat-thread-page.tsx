import { useEffectEvent } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlusIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button, buttonVariants } from "@stella/ui/components/button";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useDevStore } from "@/lib/dev-store";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import { chatThreadOptions } from "@/routes/_protected.chat/-queries";

type ChatThreadPageProps = {
  threadRef: ChatThreadRef;
  workspaceId?: string | undefined;
};

export const ChatThreadPage = ({
  threadRef,
  workspaceId,
}: ChatThreadPageProps) => {
  const t = useTranslations();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const showToolCalls = useDevStore((state) => state.showToolCalls);
  const controller = useChatEditor({ threadRef });

  const { data: chat } = useSuspenseQuery(
    chatThreadOptions({
      key: threadRef,
      context: { getUserContext },
    }),
  );

  const {
    messages,
    sendMessage,
    stop,
    isGenerating,
    autoApprovedTools,
    handleApprove,
    handleDeny,
    handleAlwaysAllow,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({ chat, workspaceId });

  return (
    <div className="flex w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2">
        <Link
          className={buttonVariants({
            variant: "ghost",
            size: "sm",
          })}
          to="/chat"
        >
          <PlusIcon />
          {t("chat.newChat")}
        </Link>
        <ThreadsSheet />
      </div>

      <Conversation>
        <ConversationContent className="gap-4 p-4">
          <ChatThreadMessages
            approvalPendingMessageId={approvalPendingMessageId}
            autoApprovedTools={autoApprovedTools}
            handleAlwaysAllow={handleAlwaysAllow}
            handleApprove={handleApprove}
            handleDeny={handleDeny}
            isGenerating={isGenerating}
            messages={messages}
            onAskUserSubmit={async (text) => {
              await sendMessage({ text });
            }}
            showThinkingIndicator
            showToolCalls={showToolCalls}
            streamdownComponents={streamdownComponents}
            workspaceId={workspaceId}
          />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="flex items-end gap-2 p-4">
        <ChatInputSurface
          className="flex-1"
          controller={controller}
          disabled={isGenerating}
          onSubmit={async (draft) => {
            await sendMessage(await buildChatRequestMessage(draft));
          }}
        />
        {isGenerating && (
          <Button
            aria-label={t("common.cancel")}
            onClick={async () => await stop()}
            size="icon-sm"
            variant="outline"
          >
            <SquareIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
};
