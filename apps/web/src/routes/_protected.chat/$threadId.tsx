import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { isToolUIPart } from "ai";
import { PlusIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button, buttonVariants } from "@stella/ui/components/button";
import { cn } from "@stella/ui/lib/utils";

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
import { AskUserCard } from "@/components/chat/ask-user-card";
import { isApprovalPart } from "@/components/chat/chat-ui-tools";
import { DocumentViewCard } from "@/components/chat/document-view-card";
import { SourceChips } from "@/components/chat/source-chips";
import { SystemPromptMessage } from "@/components/chat/system-prompt-message";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { UserMessageText } from "@/components/chat/user-message-text";
import { ChatEditor } from "@/components/mentionable-prompt-input";
import { GLOBAL_MENTION_CONTEXT } from "@/lib/chat-mention-context";
import { useDevStore } from "@/lib/dev-store";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useSuspenseChatActor } from "@/routes/_protected.chat/-hooks/chat-actor-provider";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { chatThreadOptions } from "@/routes/_protected.chat/-queries";

const getModelId = () => useDevStore.getState().chatModelId;

export const Route = createFileRoute("/_protected/chat/$threadId")({
  component: ThreadRoute,
});

function ThreadRoute() {
  const t = useTranslations();
  const threadId = Route.useParams({ select: (p) => p.threadId });
  const { connection } = useSuspenseChatActor();
  const userContext = useChatUserContext();
  const showToolCalls = useDevStore((s) => s.showToolCalls);

  const { data: chat } = useSuspenseQuery(
    chatThreadOptions({
      key: { threadId },
      context: {
        connection,
        userContext,
        getModelId,
      },
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
  } = useChatSession({ chat, threadId });

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
            <Message
              className={cn(
                "transition-opacity duration-200",
                approvalPendingMessageId &&
                  approvalPendingMessageId !== message.id &&
                  "opacity-40",
              )}
              from={message.role}
              key={message.id}
            >
              <MessageContent>
                {message.role === "assistant" ? (
                  <>
                    {message.parts.map((part, i) => {
                      if (part.type === "text") {
                        return (
                          <MessageResponse
                            components={streamdownComponents}
                            // eslint-disable-next-line react/no-array-index-key
                            key={`${message.id}-text-${i}`}
                          >
                            {part.text}
                          </MessageResponse>
                        );
                      }
                      if (part.type === "tool-askUser") {
                        return (
                          <AskUserCard
                            key={part.toolCallId}
                            // eslint-disable-next-line typescript/no-misused-promises
                            onSubmit={async (text) =>
                              await sendMessage({ text })
                            }
                            part={part}
                          />
                        );
                      }
                      if (
                        part.type === "tool-displayDocument" &&
                        part.state === "output-available"
                      ) {
                        return (
                          <DocumentViewCard
                            key={part.toolCallId}
                            result={part.output}
                          />
                        );
                      }
                      if (isApprovalPart(part)) {
                        return (
                          <ToolApprovalCard
                            autoApprovedTools={autoApprovedTools}
                            key={part.toolCallId}
                            onAlwaysAllow={handleAlwaysAllow}
                            // eslint-disable-next-line typescript/no-misused-promises
                            onApprove={handleApprove}
                            // eslint-disable-next-line typescript/no-misused-promises
                            onDeny={handleDeny}
                            part={part}
                          />
                        );
                      }
                      if (isToolUIPart(part) && showToolCalls) {
                        return (
                          <ToolCallCard key={part.toolCallId} part={part} />
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
                        // eslint-disable-next-line react/no-array-index-key
                        key={`${message.id}-text-${i}`}
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
          // eslint-disable-next-line typescript/no-misused-promises
          onSubmit={async (text) => await sendMessage({ text })}
        />
        {isGenerating && (
          <Button
            aria-label={t("common.cancel")}
            // eslint-disable-next-line typescript/no-misused-promises
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
}
