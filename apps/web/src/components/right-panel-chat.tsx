import { Suspense, useEffect, useMemo, useState } from "react";
import { useChat, type Chat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isToolUIPart, type UIMessage } from "ai";
import { MessageSquareIcon, PlusIcon, TrashIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
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
import { EntityLink } from "@/components/chat/entity-link";
import { SourceChips } from "@/components/chat/source-chips";
import { SystemPromptMessage } from "@/components/chat/system-prompt-message";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { UserMessageText } from "@/components/chat/user-message-text";
import { ChatEditor } from "@/components/mentionable-prompt-input";
import type { ChatActor } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { useDevStore } from "@/lib/dev-store";
import { eventHandlerV2 } from "@/lib/rivet";
import { useChatActor } from "@/routes/_protected.chat/-hooks/use-chat-actor";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import {
  chatKeys,
  chatThreadOptions,
  chatThreadsOptions,
  chatWorkspaceThreadsOptions,
} from "@/routes/_protected.chat/-queries";

type RightPanelChatProps = {
  workspaceId?: string;
};

export const RightPanelChat = ({ workspaceId }: RightPanelChatProps) => {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // Reset active thread when workspace changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceId is a prop; re-run is intentional
  useEffect(() => {
    setActiveThreadId(null);
  }, [workspaceId]);

  return activeThreadId ? (
    <Suspense>
      <ActiveThread
        onBack={() => setActiveThreadId(null)}
        onSwitchThread={setActiveThreadId}
        threadId={activeThreadId}
        workspaceId={workspaceId}
      />
    </Suspense>
  ) : (
    <NewChat onThreadCreated={setActiveThreadId} workspaceId={workspaceId} />
  );
};

// -- New chat (greeting + prompt) --

type NewChatProps = {
  onThreadCreated: (threadId: string) => void;
  workspaceId?: string;
};

const getModelId = () => useDevStore.getState().chatModelId;

const NewChat = ({ onThreadCreated, workspaceId }: NewChatProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-3">
        <MessageSquareIcon className="size-8 text-muted-foreground/30" />
        <p className="text-sm font-medium text-foreground">
          {t("chat.greeting")}
        </p>
      </div>
      <div className="p-3">
        <ChatEditor
          autoFocus
          className="min-h-10 rounded-lg border px-3 py-2"
          onSubmit={async (text) => {
            const threadId = nanoid();
            const chat = await queryClient.ensureQueryData(
              chatThreadOptions({
                threadId,
                queryClient,
                workspaceId,
                getModelId,
                userContext,
              }),
            );
            chat.sendMessage({ text });
            onThreadCreated(threadId);
          }}
          workspaceId={workspaceId}
        />
      </div>
    </div>
  );
};

// -- Active thread (conversation) --

type ActiveThreadProps = {
  threadId: string;
  workspaceId?: string;
  onBack: () => void;
  onSwitchThread: (threadId: string) => void;
};

const ActiveThread = ({
  threadId,
  workspaceId,
  onBack,
  onSwitchThread,
}: ActiveThreadProps) => {
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();
  const { data: chat, isLoading } = useQuery(
    chatThreadOptions({
      threadId,
      queryClient,
      workspaceId,
      getModelId,
      userContext,
    }),
  );

  if (isLoading || !chat) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="size-4 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground" />
      </div>
    );
  }

  return (
    <ActiveThreadInner
      chat={chat}
      onBack={onBack}
      onSwitchThread={onSwitchThread}
      threadId={threadId}
      workspaceId={workspaceId}
    />
  );
};

type ActiveThreadInnerProps = {
  threadId: string;
  workspaceId?: string;
  chat: Chat<UIMessage>;
  onBack: () => void;
  onSwitchThread: (threadId: string) => void;
};

const ActiveThreadInner = ({
  threadId,
  workspaceId,
  chat,
  onBack,
  onSwitchThread,
}: ActiveThreadInnerProps) => {
  const t = useTranslations();
  const actor = useChatActor();
  const showToolCalls = useDevStore((s) => s.showToolCalls);

  const { messages, sendMessage, setMessages, stop } = useChat({
    chat,
    resume: true,
  });

  // Stable Streamdown overrides for entity links.
  const streamdownComponents = useMemo(
    () => (workspaceId ? { a: EntityLink } : undefined),
    [workspaceId],
  );

  const chatEvent = eventHandlerV2<ChatActor>();

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
      await chat.resumeStream();
    }),
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        className={cn(
          "flex items-center gap-1 border-b px-2",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Button
          onClick={onBack}
          size="icon-sm"
          title={t("chat.newChat")}
          variant="ghost"
        >
          <PlusIcon className="size-3.5" />
        </Button>
        <ThreadList
          activeThreadId={threadId}
          onSwitchThread={onSwitchThread}
          workspaceId={workspaceId}
        />
      </div>
      <Conversation>
        <ConversationContent className="gap-4 p-3">
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
                    <SourceChips
                      messageId={message.id}
                      parts={message.parts}
                      workspaceId={workspaceId}
                    />
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
      <div className="p-3">
        <ChatEditor
          autoFocus
          className="min-h-10 rounded-lg border px-3 py-2"
          onSubmit={(text) => sendMessage({ text })}
          workspaceId={workspaceId}
        />
      </div>
    </div>
  );
};

// -- Thread list (inline in panel) --

type ThreadListProps = {
  activeThreadId: string;
  workspaceId?: string;
  onSwitchThread: (threadId: string) => void;
};

const ThreadList = ({
  activeThreadId,
  workspaceId,
  onSwitchThread,
}: ThreadListProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const actor = useChatActor();
  const [expanded, setExpanded] = useState(false);

  const { data: threads } = useQuery(
    workspaceId
      ? chatWorkspaceThreadsOptions(workspaceId, queryClient)
      : chatThreadsOptions(queryClient),
  );

  const chatEvent = eventHandlerV2<ChatActor>();

  const threadsQueryKey = workspaceId
    ? chatKeys.workspaceThreads(workspaceId)
    : chatKeys.threads;

  actor.useEvent(
    ...chatEvent("thread-created", (data) => {
      if (workspaceId && data.workspaceId !== workspaceId) {
        return;
      }
      queryClient.setQueryData(
        threadsQueryKey,
        (prev: typeof threads) => prev && [...prev, data],
      );
    }),
  );

  actor.useEvent(
    ...chatEvent("thread-deleted", (data) => {
      queryClient.setQueryData(threadsQueryKey, (prev: typeof threads) =>
        prev?.filter((thread) => thread.id !== data.threadId),
      );
      queryClient.removeQueries({
        queryKey: chatKeys.thread(data.threadId),
      });
    }),
  );

  const sortedThreads = threads
    ? [...threads].sort((a, b) => b.createdAt - a.createdAt)
    : [];

  if (!expanded) {
    return (
      <Button
        className="ml-auto"
        onClick={() => setExpanded(true)}
        size="icon-sm"
        title={t("chat.threads")}
        variant="ghost"
      >
        <MessageSquareIcon className="size-3.5" />
      </Button>
    );
  }

  return (
    <div className="relative ml-auto flex items-center gap-1">
      <Button onClick={() => setExpanded(false)} size="sm" variant="ghost">
        <MessageSquareIcon className="size-3.5" />
        {t("chat.threads")}
      </Button>
      {expanded && sortedThreads.length > 0 && (
        <div
          className="absolute top-[calc(100%+4px)] right-2 z-20 max-h-64 w-56 overflow-y-auto rounded-lg border bg-popover shadow-md"
          role="listbox"
        >
          {sortedThreads.map((thread) => (
            <div
              aria-selected={thread.id === activeThreadId}
              className={cn(
                "group flex w-full cursor-pointer",
                "items-center gap-2 px-3 py-2",
                "text-left text-sm transition-colors",
                "hover:bg-muted",
                thread.id === activeThreadId && "bg-muted font-medium",
              )}
              key={thread.id}
              onClick={() => {
                onSwitchThread(thread.id);
                setExpanded(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  onSwitchThread(thread.id);
                  setExpanded(false);
                }
              }}
              role="option"
              tabIndex={0}
            >
              <span className="flex-1 truncate">{thread.title}</span>
              <Button
                className="shrink-0 opacity-0 group-hover:opacity-100 [&:hover]:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  actor.connection?.deleteThread({
                    threadId: thread.id,
                  });
                }}
                size="icon-xs"
                variant="ghost"
              >
                <TrashIcon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
