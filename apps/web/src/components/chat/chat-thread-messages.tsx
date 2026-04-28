import type { ComponentProps } from "react";

import { isToolUIPart } from "ai";
import type { FileUIPart } from "ai";
import { FileTextIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { AskUserCard } from "@/components/chat/ask-user-card";
import type {
  ApprovalToolName,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { isApprovalPart } from "@/components/chat/chat-ui-tools";
import { SourceChips } from "@/components/chat/source-chips";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { getUserFileContentUrl } from "@/lib/user-files";

const USER_STREAMDOWN_COMPONENTS = {
  a: (props: ComponentProps<"a">) => (
    <StreamdownMentionLink interactive={false} {...props} />
  ),
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getMentionTagAttr = (attrs: string, name: string) => {
  const attrName = escapeRegExp(name);
  const match = new RegExp(
    `(?:^|\\s)${attrName}\\s*=\\s*(["'])(.*?)\\1`,
    "i",
  ).exec(attrs);

  return match?.[2] ?? null;
};

const replaceMentionTag = (rawAttrs: string) => {
  const id = getMentionTagAttr(rawAttrs, "data-id");
  const label = getMentionTagAttr(rawAttrs, "data-label");
  const category = getMentionTagAttr(rawAttrs, "data-category");

  if (!id || !label || !category) {
    return "";
  }

  return `<a href="#stella-${category}=${id}">${label}</a>`;
};

const normalizeUserMessageTextForDisplay = (text: string) => {
  const openTag = "<entity-mention";
  const closeTag = "</entity-mention>";
  let cursor = 0;
  let result = "";

  while (cursor < text.length) {
    const start = text.indexOf(openTag, cursor);
    if (start === -1) {
      result += text.slice(cursor);
      break;
    }

    const tagEnd = text.indexOf(">", start + openTag.length);
    if (tagEnd === -1) {
      result += text.slice(cursor);
      break;
    }

    const isSelfClosing = text.slice(tagEnd - 1, tagEnd + 1) === "/>";
    const closedTagEnd = tagEnd + 1 + closeTag.length;
    const isClosed = text.slice(tagEnd + 1, closedTagEnd) === closeTag;
    if (!isSelfClosing && !isClosed) {
      result += text.slice(cursor, tagEnd + 1);
      cursor = tagEnd + 1;
      continue;
    }

    result += text.slice(cursor, start);
    result += replaceMentionTag(text.slice(start + openTag.length, tagEnd));
    cursor = isSelfClosing ? tagEnd + 1 : closedTagEnd;
  }

  return result;
};

const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const UserAttachments = ({ parts }: { parts: readonly FileUIPart[] }) => {
  if (parts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {parts.map((part, index) => {
        const key = `${part.filename ?? "attachment"}-${index}`;
        const contentUrl = getUserFileContentUrl(part.url) ?? part.url;
        if (IMAGE_MEDIA_TYPES.has(part.mediaType)) {
          return (
            <a href={contentUrl} key={key} rel="noreferrer" target="_blank">
              <img
                alt={part.filename ?? "Attached image"}
                className="max-h-32 rounded-md object-cover"
                height={128}
                src={contentUrl}
                width={128}
              />
            </a>
          );
        }

        return (
          <a
            className={cn(
              "flex items-center gap-1.5",
              "bg-muted/50 rounded-md px-2 py-1",
              "text-muted-foreground text-xs",
            )}
            href={contentUrl}
            key={key}
            rel="noreferrer"
            target="_blank"
          >
            <FileTextIcon className="size-3" />
            <span>{part.filename ?? "Attachment"}</span>
          </a>
        );
      })}
    </div>
  );
};

const ThinkingIndicator = () => {
  const t = useTranslations();

  return (
    <Message from="assistant">
      <MessageContent>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <div className="bg-muted relative h-1 w-9 overflow-hidden rounded-full">
            <div className="bg-foreground/35 h-full w-1/2 animate-pulse rounded-full" />
          </div>
          <span>{t("chat.thinking")}</span>
        </div>
      </MessageContent>
    </Message>
  );
};

const hasVisibleContent = (
  messages: readonly PersistedChatMessage[],
  showToolCalls: boolean,
): boolean => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      break;
    }

    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) {
        return true;
      }

      if (isApprovalPart(part) || part.type === "tool-ask-user") {
        return true;
      }

      if (isToolUIPart(part) && showToolCalls) {
        return true;
      }
    }
  }

  return false;
};

type ChatThreadMessagesProps = {
  approvalPendingMessageId: string | null;
  autoApprovedTools: ReadonlySet<ApprovalToolName>;
  handleAlwaysAllow: (toolName: ApprovalToolName) => void;
  handleApprove: (id: string) => void | PromiseLike<void>;
  handleDeny: (id: string) => void | PromiseLike<void>;
  isGenerating?: boolean | undefined;
  messages: PersistedChatMessage[];
  onAskUserSubmit: (text: string) => Promise<void>;
  showThinkingIndicator?: boolean | undefined;
  showToolCalls: boolean;
  streamdownComponents: {
    a: (props: ComponentProps<"a">) => React.ReactNode;
  };
  workspaceId?: string | undefined;
};

export const ChatThreadMessages = ({
  approvalPendingMessageId,
  autoApprovedTools,
  handleAlwaysAllow,
  handleApprove,
  handleDeny,
  isGenerating = false,
  messages,
  onAskUserSubmit,
  showThinkingIndicator = false,
  showToolCalls,
  streamdownComponents,
  workspaceId,
}: ChatThreadMessagesProps) => (
  <>
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
              {message.parts.map((part, index) => {
                if (part.type === "text") {
                  return (
                    <MessageResponse
                      components={streamdownComponents}
                      key={`${message.id}-text-${index}`}
                    >
                      {part.text}
                    </MessageResponse>
                  );
                }

                if (part.type === "tool-ask-user") {
                  return (
                    <AskUserCard
                      key={part.toolCallId}
                      onSubmit={onAskUserSubmit}
                      part={part}
                      workspaceId={workspaceId}
                    />
                  );
                }

                if (isApprovalPart(part)) {
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

                if (isToolUIPart(part) && showToolCalls) {
                  return <ToolCallCard key={part.toolCallId} part={part} />;
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
              {(() => {
                const fileParts: FileUIPart[] = [];
                for (const part of message.parts) {
                  if (part.type === "file") {
                    fileParts.push(part);
                  }
                }

                return <UserAttachments parts={fileParts} />;
              })()}
              {message.parts.map((part, index) =>
                part.type === "text" ? (
                  <MessageResponse
                    components={USER_STREAMDOWN_COMPONENTS}
                    key={`${message.id}-user-text-${index}`}
                  >
                    {normalizeUserMessageTextForDisplay(part.text)}
                  </MessageResponse>
                ) : null,
              )}
            </>
          )}
        </MessageContent>
      </Message>
    ))}
    {showThinkingIndicator &&
      isGenerating &&
      !hasVisibleContent(messages, showToolCalls) && <ThinkingIndicator />}
  </>
);
