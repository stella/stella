import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { Chat } from "@ai-sdk/react";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor as TipTapEditor } from "@tiptap/react";
import { getToolName, isToolUIPart } from "ai";
import type { FileUIPart, UIMessage } from "ai";
import {
  ArrowUpIcon,
  FileTextIcon,
  MessageSquareIcon,
  PaperclipIcon,
  PlusIcon,
  TrashIcon,
  UploadIcon,
} from "lucide-react";
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
import { AttachmentChips } from "@/components/chat/attachment-chips";
import { DocumentViewCard } from "@/components/chat/document-view-card";
import { SourceChips } from "@/components/chat/source-chips";
import { SystemPromptMessage } from "@/components/chat/system-prompt-message";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { useChatAttachments } from "@/components/chat/use-chat-attachments";
import { UserMessageText } from "@/components/chat/user-message-text";
import { ChatEditor } from "@/components/mentionable-prompt-input";
import type { MentionContext } from "@/components/mentionable-prompt-input";
import type {
  ActiveFileContext,
  ProcessedAttachment,
} from "@/lib/ai-sdk/rivet-transport";
import type { ChatActor } from "@/lib/api";
import {
  GLOBAL_MENTION_CONTEXT,
  workspaceMentionContext,
} from "@/lib/chat-mention-context";
import { useChatPanelStore } from "@/lib/chat-panel-store";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { useDevStore } from "@/lib/dev-store";
import { eventHandlerV2 } from "@/lib/rivet";
import { useChatActor } from "@/routes/_protected.chat/-hooks/use-chat-actor";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import {
  chatKeys,
  chatThreadOptions,
  chatThreadsOptions,
  chatWorkspaceThreadsOptions,
} from "@/routes/_protected.chat/-queries";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

/** Set up the chat panel container as a pragmatic DnD drop
 *  target for entity mentions + native file drag overlay.
 *  Returns { containerRef, isDragOver }. */
const useEntityDropTarget = (workspaceId: string | undefined) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !workspaceId) {
      return;
    }
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => source.data.type === ENTITY_DRAG_TYPE,
      onDragEnter: () => setIsDragOver(true),
      onDragLeave: () => setIsDragOver(false),
      onDrop: ({ source }) => {
        setIsDragOver(false);
        // SAFETY: entities is always set by our own draggable getInitialData.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const entities = source.data.entities as {
          entityId: string;
          name: string;
          kind: string;
          mimeType: string | null;
        }[];
        const mentions = entities.map((e) => ({
          id: e.entityId,
          label: e.name,
          category: "entity" as const,
          kind: e.kind,
          mimeType: e.mimeType,
          workspaceId,
        }));
        useChatPanelStore.getState().requestChatAbout(mentions);
      },
    });
  }, [workspaceId]);

  return { containerRef, isDragOver };
};

const DropOverlay = () => {
  const t = useTranslations();
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-50",
        "flex items-center justify-center rounded-lg",
        "border-foreground/20 border-2 border-dashed",
        "bg-foreground/5",
      )}
    >
      <div className="text-foreground/50 flex flex-col items-center gap-2">
        <UploadIcon className="size-6" />
        <span className="text-xs font-medium">{t("chat.chatAbout")}</span>
      </div>
    </div>
  );
};

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

// -- Thinking indicator (shown before first content arrives) --

const ThinkingIndicator = () => {
  const t = useTranslations();
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <div
                className="bg-muted-foreground/40 size-1.5 animate-pulse rounded-full"
                key={i}
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </div>
          <span>{t("chat.thinking")}</span>
        </div>
      </MessageContent>
    </Message>
  );
};

/** Check if the last assistant message has any visible content
 *  (non-empty text or tool call parts). Used to determine
 *  whether to show the thinking indicator. */
const hasVisibleContent = (messages: UIMessage[]): boolean => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") {
      break;
    }
    for (const part of msg.parts) {
      if (part.type === "text" && part.text.trim()) {
        return true;
      }
      if (isToolUIPart(part)) {
        return true;
      }
    }
  }
  return false;
};

// -- Attachment helpers --

/** Split drained attachments into native files (sent as
 *  message file parts) and extracted text (sent via the
 *  transport side channel for system prompt injection). */
const splitAttachments = (
  drained: ProcessedAttachment[],
): {
  files: FileUIPart[];
  textAttachments: ProcessedAttachment[];
} => {
  const files: FileUIPart[] = [];
  const textAttachments: ProcessedAttachment[] = [];

  for (const att of drained) {
    if (att.type === "native-file") {
      files.push({
        type: "file",
        url: att.dataUrl,
        mediaType: att.mediaType,
        filename: att.filename,
      });
    } else {
      textAttachments.push(att);
      // Also create a display-only file part so the
      // attachment is visible in the user message history.
      // The actual content is injected into the system
      // prompt via the side channel.
      files.push({
        type: "file",
        url: "data:text/plain,",
        mediaType: att.mediaType,
        filename: att.filename,
      });
    }
  }

  return { files, textAttachments };
};

const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Render file parts attached to a user message. */
const UserAttachments = ({ parts }: { parts: FileUIPart[] }) => {
  if (parts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {parts.map((part, i) => {
        const isImage = IMAGE_MEDIA_TYPES.has(part.mediaType);

        if (isImage) {
          return (
            <img
              alt={part.filename ?? "Attached image"}
              className="max-h-32 rounded-md object-cover"
              height={128}
              // eslint-disable-next-line react/no-array-index-key
              key={`file-${i}`}
              width={128}
              src={part.url}
            />
          );
        }

        return (
          <div
            className={cn(
              "flex items-center gap-1.5",
              "bg-muted/50 rounded-md px-2 py-1",
              "text-muted-foreground text-xs",
            )}
            // eslint-disable-next-line react/no-array-index-key
            key={`file-${i}`}
          >
            <FileTextIcon className="size-3" />
            <span className="truncate">{part.filename ?? "Attachment"}</span>
          </div>
        );
      })}
    </div>
  );
};

// -- Shared chat input bar (unified container) --

type ChatInputBarProps = {
  attachments: ReturnType<typeof useChatAttachments>;
  mentionContext: MentionContext;
  onSubmit: (
    text: string,
    drained: ReturnType<
      ReturnType<typeof useChatAttachments>["drainAttachments"]
    >,
  ) => void;
};

const ChatInputBar = ({
  attachments,
  mentionContext,
  onSubmit,
}: ChatInputBarProps) => {
  const t = useTranslations();
  const submitRef = useRef<(() => void) | null>(null);
  const editorRef = useRef<TipTapEditor | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);

  // Consume pending "chat about this" mentions from the store.
  const chatRequestSeq = useChatPanelStore((s) => s.requestSeq);
  const consumeMentions = useChatPanelStore((s) => s.consumeMentions);
  const lastConsumedSeq = useRef(0);

  useEffect(() => {
    if (chatRequestSeq <= lastConsumedSeq.current) {
      return;
    }
    lastConsumedSeq.current = chatRequestSeq;
    const mentions = consumeMentions();
    const editor = editorRef.current;
    if (mentions.length === 0 || !editor) {
      return;
    }
    const chain = editor.chain().focus();
    for (const mention of mentions) {
      chain
        .insertContent({
          type: "mention",
          attrs: {
            id: mention.id,
            label: mention.label,
            category: mention.category,
            kind: mention.kind,
            mimeType: mention.mimeType,
            sourceWorkspaceId: mention.workspaceId,
          },
        })
        .insertContent(" ");
    }
    chain.run();
  }, [chatRequestSeq, consumeMentions]);

  const handleSubmit = (text: string) => {
    if (attachments.isSendBlocked) {
      return;
    }
    const drained = attachments.drainAttachments();
    onSubmit(text, drained);
    setIsEmpty(true);
  };

  const hasPendingFiles = attachments.pendingFiles.length > 0;
  const hasContent = !isEmpty || hasPendingFiles;

  return (
    <div
      className={cn(
        "bg-muted/30 rounded-lg border",
        "focus-within:border-ring transition-colors",
      )}
    >
      {hasPendingFiles && (
        <AttachmentChips
          files={attachments.pendingFiles}
          onRemove={attachments.removeFile}
        />
      )}
      <ChatEditor
        autoFocus
        className="px-3 pt-2 pb-1"
        editorRef={editorRef}
        mentionContext={mentionContext}
        onEmptyChange={setIsEmpty}
        onSubmit={handleSubmit}
        submitRef={submitRef}
      />
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        <Button
          disabled={attachments.isUploading}
          onClick={attachments.openFilePicker}
          size="icon-sm"
          title={t("chat.attachFile")}
          variant="ghost"
        >
          <PaperclipIcon className="size-3.5" />
        </Button>
        <input {...attachments.fileInputProps} />
        <Button
          className={cn(
            "ms-auto shrink-0 transition-colors",
            hasContent &&
              "bg-foreground text-background hover:bg-foreground/90",
          )}
          disabled={attachments.isSendBlocked}
          onClick={() => submitRef.current?.()}
          size="icon-sm"
          title={t("chat.send")}
          variant={hasContent ? "default" : "ghost"}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
};

// -- New chat (greeting + prompt) --

type NewChatProps = {
  onThreadCreated: (threadId: string) => void;
  workspaceId?: string;
  mentionContext: MentionContext;
};

const makeGetActiveFile =
  (workspaceId: string | undefined) => (): ActiveFileContext | undefined => {
    // Only provide inspector context inside a workspace;
    // the global chat panel should not leak stale state
    // from a previously visited workspace.
    if (!workspaceId) {
      return;
    }
    const { tabs, activeId } = useInspectorStore.getState();
    const tab = tabs.find((t) => t.id === activeId);
    if (tab?.type !== "pdf") {
      return;
    }
    // Guard against cross-workspace contamination: only
    // return the active file if it belongs to the current
    // workspace.
    if (tab.workspaceId !== workspaceId) {
      return;
    }
    return { entityId: tab.entityId, fileName: tab.label };
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
  const getActiveFile = useMemo(
    () => makeGetActiveFile(workspaceId),
    [workspaceId],
  );

  const attachments = useChatAttachments();
  const entityDrop = useEntityDropTarget(workspaceId);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="relative flex flex-1 flex-col overflow-hidden"
      onDragOver={attachments.dropZoneProps.onDragOver}
      onDrop={attachments.dropZoneProps.onDrop}
      onPaste={attachments.dropZoneProps.onPaste}
      ref={entityDrop.containerRef}
    >
      {entityDrop.isDragOver && <DropOverlay />}
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-4 px-3",
          entityDrop.isDragOver && "invisible",
        )}
      >
        <MessageSquareIcon className="text-muted-foreground/30 size-8" />
        <p className="text-foreground text-sm font-medium">
          {t("chat.greeting")}
        </p>
      </div>
      <div className="p-3">
        <ChatInputBar
          attachments={attachments}
          mentionContext={mentionContext}
          // eslint-disable-next-line typescript/no-misused-promises
          onSubmit={async (text, drained) => {
            const threadId = nanoid();
            const chat = await queryClient.ensureQueryData(
              chatThreadOptions({
                threadId,
                queryClient,
                workspaceId,
                getModelId,
                userContext,
                getActiveFile,
              }),
            );
            const { files, textAttachments } = splitAttachments(drained);
            if (textAttachments.length > 0 && "setAttachments" in chat) {
              // SAFETY: `setAttachments` is added by our custom rivet transport;
              // the `in` check above narrows at runtime but TS cannot infer.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              const chatWithAttachments = chat as {
                setAttachments: (a: ProcessedAttachment[]) => void;
              };
              chatWithAttachments.setAttachments(textAttachments);
            }
            // eslint-disable-next-line typescript/no-floating-promises
            chat.sendMessage(files.length > 0 ? { text, files } : { text });
            onThreadCreated(threadId);
          }}
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
  const getActiveFile = useMemo(
    () => makeGetActiveFile(workspaceId),
    [workspaceId],
  );
  const { data: chat, isLoading } = useQuery(
    chatThreadOptions({
      threadId,
      queryClient,
      workspaceId,
      getModelId,
      userContext,
      getActiveFile,
    }),
  );

  if (isLoading || !chat) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="border-foreground/20 border-t-foreground size-4 animate-spin rounded-full border-2" />
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
  const showToolCalls = useDevStore((s) => s.showToolCalls);

  const {
    messages,
    sendMessage,
    isGenerating,
    autoApprovedTools,
    handleApprove,
    handleDeny,
    handleAlwaysAllow,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({ chat, threadId });

  const attachments = useChatAttachments();
  const entityDrop = useEntityDropTarget(workspaceId);

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
        // eslint-disable-next-line typescript/no-floating-promises
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        });
        return;
      }
    }
  }, [messages, workspaceId, queryClient]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="relative flex flex-1 flex-col overflow-hidden"
      onDragOver={attachments.dropZoneProps.onDragOver}
      onDrop={attachments.dropZoneProps.onDrop}
      onPaste={attachments.dropZoneProps.onPaste}
      ref={entityDrop.containerRef}
    >
      {entityDrop.isDragOver && <DropOverlay />}
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
                        // Skip empty or internal-ID-only text
                        // (model sometimes leaks tool node IDs).
                        if (!part.text.trim()) {
                          return null;
                        }
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
                      if (isToolUIPart(part)) {
                        if (getToolName(part) === "askUser") {
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
                          getToolName(part) === "displayDocument" &&
                          part.state === "output-available" &&
                          part.output !== undefined &&
                          part.output !== null
                        ) {
                          // SAFETY: output matches the displayDocument
                          // tool's return shape; the tool is defined in
                          // chat-document-tools.ts.
                          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                          const output = part.output as {
                            filename: string;
                            view: string;
                            text: string;
                          };
                          return (
                            <DocumentViewCard
                              key={part.toolCallId}
                              result={output}
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
                              // eslint-disable-next-line typescript/no-misused-promises
                              onApprove={handleApprove}
                              // eslint-disable-next-line typescript/no-misused-promises
                              onDeny={handleDeny}
                              part={part}
                              workspaceId={workspaceId}
                            />
                          );
                        }
                        return (
                          <ToolCallCard
                            key={part.toolCallId}
                            part={part}
                            showDetails={showToolCalls}
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
                  <>
                    <UserAttachments
                      parts={message.parts.filter(
                        (p): p is FileUIPart => p.type === "file",
                      )}
                    />
                    {message.parts.map((part, i) =>
                      part.type === "text" ? (
                        <UserMessageText
                          // eslint-disable-next-line react/no-array-index-key
                          key={`${message.id}-text-${i}`}
                          text={part.text}
                        />
                      ) : null,
                    )}
                  </>
                )}
              </MessageContent>
            </Message>
          ))}
          {isGenerating && !hasVisibleContent(messages) && (
            <ThinkingIndicator />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="p-3">
        <ChatInputBar
          attachments={attachments}
          mentionContext={mentionContext}
          onSubmit={(text, drained) => {
            const { files, textAttachments } = splitAttachments(drained);
            if (textAttachments.length > 0 && "setAttachments" in chat) {
              // SAFETY: `setAttachments` is added by our custom rivet transport;
              // the `in` check above narrows at runtime but TS cannot infer.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              const chatWithAttachments = chat as {
                setAttachments: (a: ProcessedAttachment[]) => void;
              };
              chatWithAttachments.setAttachments(textAttachments);
            }
            // eslint-disable-next-line typescript/no-floating-promises
            sendMessage(files.length > 0 ? { text, files } : { text });
          }}
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
    ? [...threads].toSorted((a, b) => b.createdAt - a.createdAt)
    : [];

  if (!expanded) {
    return (
      <Button
        className="ms-auto"
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
    <div className="relative ms-auto flex items-center gap-1">
      <Button onClick={() => setExpanded(false)} size="sm" variant="ghost">
        <MessageSquareIcon className="size-3.5" />
        {t("chat.threads")}
      </Button>
      {expanded && sortedThreads.length > 0 && (
        <div
          className="bg-popover absolute end-2 top-[calc(100%+4px)] z-20 max-h-64 w-56 overflow-y-auto rounded-lg border shadow-md"
          role="listbox"
        >
          {sortedThreads.map((thread) => (
            <div
              aria-selected={thread.id === activeThreadId}
              className={cn(
                "group flex w-full cursor-pointer",
                "items-center gap-2 px-3 py-2",
                "text-start text-sm transition-colors",
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
                  // eslint-disable-next-line typescript/no-floating-promises
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
