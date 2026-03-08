import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChat, type Chat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
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
import { AskUserCard } from "@/components/chat/ask-user-card";
import { EntityLink } from "@/components/chat/entity-link";
import { SourceChips } from "@/components/chat/source-chips";
import { SystemPromptMessage } from "@/components/chat/system-prompt-message";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { UserMessageText } from "@/components/chat/user-message-text";
import {
  ChatEditor,
  type MentionContext,
} from "@/components/mentionable-prompt-input";
import type { ChatActor } from "@/lib/api";
import {
  GLOBAL_MENTION_CONTEXT,
  workspaceMentionContext,
} from "@/lib/chat-mention-context";
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
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

type RightPanelChatProps = {
  workspaceId?: string;
};

export const RightPanelChat = ({ workspaceId }: RightPanelChatProps) => {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // Workspace chat gets entity + org-level mentions;
  // non-workspace chat gets org-level mentions only.
  const mentionContext = useMemo(
    () =>
      workspaceId
        ? workspaceMentionContext(workspaceId)
        : GLOBAL_MENTION_CONTEXT,
    [workspaceId],
  );

  return activeThreadId ? (
    <Suspense>
      <ActiveThread
        mentionContext={mentionContext}
        onBack={() => setActiveThreadId(null)}
        onSwitchThread={setActiveThreadId}
        threadId={activeThreadId}
        workspaceId={workspaceId}
      />
    </Suspense>
  ) : (
    <NewChat
      mentionContext={mentionContext}
      onThreadCreated={setActiveThreadId}
      workspaceId={workspaceId}
    />
  );
};

// -- New chat (greeting + prompt) --

type NewChatProps = {
  onThreadCreated: (threadId: string) => void;
  workspaceId?: string;
  mentionContext: MentionContext;
};

const getModelId = () => useDevStore.getState().chatModelId;

const NewChat = ({
  onThreadCreated,
  workspaceId,
  mentionContext,
}: NewChatProps) => {
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
          mentionContext={mentionContext}
        />
      </div>
    </div>
  );
};

// -- Active thread (conversation) --

type ActiveThreadProps = {
  threadId: string;
  workspaceId?: string;
  mentionContext: MentionContext;
  onBack: () => void;
  onSwitchThread: (threadId: string) => void;
};

const ActiveThread = ({
  threadId,
  workspaceId,
  mentionContext,
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
      mentionContext={mentionContext}
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
  mentionContext: MentionContext;
  chat: Chat<UIMessage>;
  onBack: () => void;
  onSwitchThread: (threadId: string) => void;
};

/** Tool names that mutate workspace entities. */
const MUTATING_TOOLS = new Set(["createDocument", "updateEntityFields"]);

const ActiveThreadInner = ({
  threadId,
  workspaceId,
  mentionContext,
  chat,
  onBack,
  onSwitchThread,
}: ActiveThreadInnerProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const actor = useChatActor();
  const showToolCalls = useDevStore((s) => s.showToolCalls);

  const [autoApprovedTools, setAutoApprovedTools] = useState(
    () => new Set<string>(),
  );

  const { messages, sendMessage, setMessages, stop, addToolApprovalResponse } =
    useChat({
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

  // Invalidate workspace entities when a mutating tool
  // completes so the table and entity links update.
  const invalidatedToolsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    for (const msg of messages) {
      if (msg.role !== "assistant") {
        continue;
      }
      for (const part of msg.parts) {
        if (
          !isToolUIPart(part) ||
          part.state !== "output-available" ||
          !MUTATING_TOOLS.has(getToolName(part))
        ) {
          continue;
        }
        const key = `${msg.id}-${getToolName(part)}`;
        if (invalidatedToolsRef.current.has(key)) {
          continue;
        }
        invalidatedToolsRef.current.add(key);
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        });
        return;
      }
    }
  }, [messages, workspaceId, queryClient]);

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
                              workspaceId={workspaceId}
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
      <div className="p-3">
        <ChatEditor
          autoFocus
          className="min-h-10 rounded-lg border px-3 py-2"
          mentionContext={mentionContext}
          onSubmit={(text) => sendMessage({ text })}
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
