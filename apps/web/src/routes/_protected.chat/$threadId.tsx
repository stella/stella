import { useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { isToolUIPart } from "ai";
import { PlusIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button, buttonVariants } from "@stella/ui/components/button";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { EntityLink } from "@/components/chat/entity-link";
import { SourceChips } from "@/components/chat/source-chips";
import { SystemPromptMessage } from "@/components/chat/system-prompt-message";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { UserMessageText } from "@/components/chat/user-message-text";
import { ChatEditor } from "@/components/mentionable-prompt-input";
import type { ChatActor } from "@/lib/api";
import { GLOBAL_MENTION_CONTEXT } from "@/lib/chat-mention-context";
import { useDevStore } from "@/lib/dev-store";
import { eventHandlerV2 } from "@/lib/rivet";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatActor } from "@/routes/_protected.chat/-hooks/use-chat-actor";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { chatThreadOptions } from "@/routes/_protected.chat/-queries";

const getModelId = () => useDevStore.getState().chatModelId;

export const Route = createFileRoute("/_protected/chat/$threadId")({
  component: ThreadRoute,
});

function ThreadRoute() {
  const t = useTranslations();
  const { threadId } = Route.useParams();
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();
  const showToolCalls = useDevStore((s) => s.showToolCalls);

  const { data: chat } = useSuspenseQuery(
    chatThreadOptions({ threadId, queryClient, userContext, getModelId }),
  );

  const { messages, sendMessage, setMessages, stop, status } = useChat({
    chat,
    resume: true,
  });

  const actor = useChatActor();
  const chatEvent = eventHandlerV2<ChatActor>();

  // Stable Streamdown overrides for mention links.
  const streamdownComponents = useMemo(() => ({ a: EntityLink }), []);

  // When another connection starts streaming for this
  // thread, stop any local stream, sync messages, and
  // resume so this tab picks up the in-progress generation.
  actor.useEvent(
    ...chatEvent("stream-started", async (data) => {
      if (data.threadId !== threadId || data.chatId === chat.id) {
        return;
      }

      await stop();

      const latest = await actor.connection?.getMessages({
        threadId,
      });
      if (latest) {
        setMessages(latest);
      }
      chat.resumeStream();
    }),
  );

  const isGenerating = status === "submitted" || status === "streaming";

  return (
    <div className="flex w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2">
        <Link
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          to="/chat"
        >
          <PlusIcon />
          {t("chat.newChat")}
        </Link>
        <ThreadsSheet />
      </div>

      <Conversation>
        <ConversationContent>
          <SystemPromptMessage threadId={threadId} />
          {messages.map((message) => (
            <Message from={message.role} key={message.id}>
              <MessageContent>
                {message.role === "assistant" ? (
                  <>
                    {message.parts.map((part, i) => {
                      if (part.type === "text") {
                        return (
                          <MessageResponse
                            components={streamdownComponents}
                            key={`${message.id}-text-${i}`}
                          >
                            {part.text}
                          </MessageResponse>
                        );
                      }
                      if (showToolCalls && isToolUIPart(part)) {
                        return (
                          <ToolCallCard
                            key={`${message.id}-tool-${i}`}
                            part={part}
                          />
                        );
                      }
                      return null;
                    })}
                    <SourceChips messageId={message.id} parts={message.parts} />
                  </>
                ) : (
                  message.parts.map((part, i) =>
                    part.type === "text" ? (
                      <UserMessageText
                        key={`${message.id}-${i}`}
                        text={part.text}
                      />
                    ) : null,
                  )
                )}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="flex items-end gap-2 p-4">
        <ChatEditor
          autoFocus
          className="min-h-10 flex-1 rounded-lg border px-3 py-2"
          mentionContext={GLOBAL_MENTION_CONTEXT}
          onSubmit={(text) => sendMessage({ text })}
        />
        {isGenerating && (
          <Button
            aria-label={t("common.cancel")}
            onClick={() => stop()}
            size="icon-sm"
            variant="outline"
          >
            <SquareIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
