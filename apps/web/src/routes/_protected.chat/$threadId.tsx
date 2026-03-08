import { useCallback, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { getToolName, isToolUIPart } from "ai";
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
import { EntityLink } from "@/components/chat/entity-link";
import { SourceChips } from "@/components/chat/source-chips";
import { SystemPromptMessage } from "@/components/chat/system-prompt-message";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
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

  const [autoApprovedTools, setAutoApprovedTools] = useState(
    () => new Set<string>(),
  );

  const {
    messages,
    sendMessage,
    setMessages,
    stop,
    status,
    addToolApprovalResponse,
  } = useChat({
    chat,
    resume: true,
  });

  const handleApprove = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: true }),
    [addToolApprovalResponse],
  );
  const handleDeny = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: false }),
    [addToolApprovalResponse],
  );
  const handleAlwaysAllow = useCallback(
    (toolName: string) =>
      setAutoApprovedTools((prev) => new Set(prev).add(toolName)),
    [],
  );

  const actor = useChatActor();
  const chatEvent = eventHandlerV2<ChatActor>();

  // Stable Streamdown overrides for mention links.
  const streamdownComponents = useMemo(() => ({ a: EntityLink }), []);

  // Dim non-approval messages when an approval is pending.
  const approvalPendingMessageId = useMemo(() => {
    for (const msg of messages) {
      if (msg.role !== "assistant") {
        continue;
      }
      for (const part of msg.parts) {
        if (isToolUIPart(part) && part.state === "approval-requested") {
          return msg.id;
        }
      }
    }
    return null;
  }, [messages]);

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
                            // biome-ignore lint/suspicious/noArrayIndexKey: text parts have no unique ID
                            key={`${message.id}-text-${i}`}
                          >
                            {part.text}
                          </MessageResponse>
                        );
                      }
                      if (isToolUIPart(part)) {
                        if (getToolName(part) === "askUser") {
                          return (
                            <AskUserCard
                              key={part.toolCallId}
                              onSubmit={(text) => sendMessage({ text })}
                              part={part}
                            />
                          );
                        }
                        if (
                          part.state === "approval-requested" ||
                          part.state === "approval-responded" ||
                          (part.state === "output-available" &&
                            "approval" in part) ||
                          (part.state === "output-error" && "approval" in part)
                        ) {
                          return (
                            <ToolApprovalCard
                              autoApprovedTools={autoApprovedTools}
                              key={part.toolCallId}
                              onAlwaysAllow={handleAlwaysAllow}
                              onApprove={handleApprove}
                              onDeny={handleDeny}
                              part={part}
                            />
                          );
                        }
                        if (showToolCalls) {
                          return (
                            <ToolCallCard key={part.toolCallId} part={part} />
                          );
                        }
                      }
                      return null;
                    })}
                    <SourceChips messageId={message.id} parts={message.parts} />
                  </>
                ) : (
                  message.parts.map((part, i) =>
                    part.type === "text" ? (
                      <UserMessageText
                        // biome-ignore lint/suspicious/noArrayIndexKey: text parts have no unique ID
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
