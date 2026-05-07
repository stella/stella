import { useMemo } from "react";
import type { ComponentProps } from "react";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { isToolUIPart } from "ai";
import type { FileUIPart } from "ai";
import { CopyIcon, FileTextIcon, RotateCcwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { AskUserCard } from "@/components/chat/ask-user-card";
import type {
  ApprovalToolName,
  AskUserOutput,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { isApprovalPart } from "@/components/chat/chat-ui-tools";
import { SourceChips } from "@/components/chat/source-chips";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import type { TranslationKey } from "@/i18n/types";
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
  const t = useTranslations();

  if (parts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {parts.map((part, index) => {
        const key = `${part.filename ?? "attachment"}-${index}`;
        const contentUrl = getUserFileContentUrl(part.url) ?? part.url;
        const fallbackLabel = t("chat.attachment");
        if (IMAGE_MEDIA_TYPES.has(part.mediaType)) {
          return (
            <a href={contentUrl} key={key} rel="noreferrer" target="_blank">
              <img
                alt={part.filename ?? t("chat.attachedImage")}
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
            <span>{part.filename ?? fallbackLabel}</span>
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

// Mirrors `AIErrorKind` in apps/api/src/lib/ai-error.ts. The
// backend's chat stream `onError` returns one of these strings as
// the error message; anything else falls through to the generic
// copy.
const CHAT_ERROR_TRANSLATION_KEYS = {
  insufficient_credits: "chat.sendErrorInsufficientCredits",
  provider_unavailable: "chat.sendErrorProviderUnavailable",
  quota_exhausted: "chat.sendErrorQuotaExhausted",
} as const satisfies Record<string, TranslationKey>;

type ChatErrorTranslationKey =
  | (typeof CHAT_ERROR_TRANSLATION_KEYS)[keyof typeof CHAT_ERROR_TRANSLATION_KEYS]
  | "chat.sendError";

const isMappedChatErrorKind = (
  message: string,
): message is keyof typeof CHAT_ERROR_TRANSLATION_KEYS =>
  message in CHAT_ERROR_TRANSLATION_KEYS;

const chatErrorTranslationKey = (error: Error): ChatErrorTranslationKey => {
  if (isMappedChatErrorKind(error.message)) {
    return CHAT_ERROR_TRANSLATION_KEYS[error.message];
  }
  return "chat.sendError";
};

export const ChatErrorMessage = ({
  error,
  isGenerating,
  onResend,
}: {
  error: Error;
  isGenerating: boolean;
  onResend?: (() => void | PromiseLike<void>) | undefined;
}) => {
  const t = useTranslations();

  return (
    <Message from="assistant">
      <MessageContent className="bg-destructive/10 border-destructive/20 text-destructive max-w-md rounded-lg border px-3 py-2">
        <p className="text-sm">{t(chatErrorTranslationKey(error))}</p>
        {onResend && (
          <Button
            className="self-start"
            disabled={isGenerating}
            onClick={() => {
              void onResend();
            }}
            size="sm"
            variant="destructive-outline"
          >
            {t("chat.resend")}
          </Button>
        )}
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

const getMessageText = (message: PersistedChatMessage) => {
  const textParts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim()) {
      textParts.push(part.text);
    }
  }

  return textParts.join("\n\n").trim();
};

const AssistantMessageActions = ({
  isGenerating,
  isLatestAssistantMessage,
  message,
  onResend,
}: {
  isGenerating: boolean;
  isLatestAssistantMessage: boolean;
  message: PersistedChatMessage;
  onResend?: (() => void | PromiseLike<void>) | undefined;
}) => {
  const t = useTranslations();
  const text = useMemo(() => getMessageText(message), [message]);
  const canRetry = Boolean(onResend && isLatestAssistantMessage);

  if (!text && !canRetry) {
    return null;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      stellaToast.add({ title: t("common.copied"), type: "success" });
    } catch {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    }
  };

  return (
    <div className="flex items-center gap-1">
      {text && (
        <Button
          aria-label={t("common.copy")}
          className="text-muted-foreground h-6 px-1.5 text-xs"
          onClick={() => {
            void handleCopy();
          }}
          size="xs"
          variant="ghost"
        >
          <CopyIcon className="size-3.5" />
          {t("common.copy")}
        </Button>
      )}
      {canRetry && (
        <Button
          aria-label={t("common.retry")}
          className="text-muted-foreground h-6 px-1.5 text-xs"
          disabled={isGenerating}
          onClick={() => {
            void onResend?.();
          }}
          size="xs"
          variant="ghost"
        >
          <RotateCcwIcon className="size-3.5" />
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
};

const getRetryableAssistantMessageId = (
  messages: readonly PersistedChatMessage[],
) => {
  const message = messages.at(-1);
  if (message?.role === "assistant") {
    return message.id;
  }

  return null;
};

type ChatThreadMessagesProps = {
  approvalPendingMessageId: string | null;
  autoApprovedTools: ReadonlySet<ApprovalToolName>;
  blockedApprovalTools?: ReadonlySet<ApprovalToolName> | undefined;
  handleAlwaysAllow: (toolName: ApprovalToolName) => void;
  handleApprove: (
    id: string,
    toolName: ApprovalToolName,
  ) => void | PromiseLike<void>;
  handleDeny: (id: string) => void | PromiseLike<void>;
  error?: Error | undefined;
  isGenerating?: boolean | undefined;
  messages: PersistedChatMessage[];
  onResend?: (() => void | PromiseLike<void>) | undefined;
  onAskUserSubmit: (
    toolCallId: string,
    output: AskUserOutput,
  ) => void | PromiseLike<void>;
  showThinkingIndicator?: boolean | undefined;
  showToolCallDetails?: boolean | undefined;
  showToolCalls?: boolean | undefined;
  streamdownComponents: {
    a: (props: ComponentProps<"a">) => React.ReactNode;
  };
  workspaceId?: string | undefined;
};

export const ChatThreadMessages = ({
  approvalPendingMessageId,
  autoApprovedTools,
  blockedApprovalTools,
  handleAlwaysAllow,
  handleApprove,
  handleDeny,
  error,
  isGenerating = false,
  messages,
  onResend,
  onAskUserSubmit,
  showThinkingIndicator = false,
  showToolCallDetails,
  showToolCalls,
  streamdownComponents,
  workspaceId,
}: ChatThreadMessagesProps) => {
  const retryableAssistantMessageId = useMemo(
    () => getRetryableAssistantMessageId(messages),
    [messages],
  );
  const shouldShowToolCalls = showToolCallDetails ?? showToolCalls ?? false;

  return (
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
                        onSubmit={(toolCallId, output) => {
                          void onAskUserSubmit(toolCallId, output);
                        }}
                        part={part}
                        workspaceId={workspaceId}
                      />
                    );
                  }

                  if (isApprovalPart(part)) {
                    return (
                      <ToolApprovalCard
                        autoApprovedTools={autoApprovedTools}
                        blockedApprovalTools={blockedApprovalTools}
                        key={part.toolCallId}
                        onAlwaysAllow={handleAlwaysAllow}
                        onApprove={handleApprove}
                        onDeny={handleDeny}
                        part={part}
                        workspaceId={workspaceId}
                      />
                    );
                  }

                  if (isToolUIPart(part) && shouldShowToolCalls) {
                    return (
                      <ToolCallCard
                        key={part.toolCallId}
                        part={part}
                        showDetails={shouldShowToolCalls}
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
                <AssistantMessageActions
                  isGenerating={isGenerating}
                  isLatestAssistantMessage={
                    message.id === retryableAssistantMessageId
                  }
                  message={message}
                  onResend={onResend}
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
      {error && (
        <ChatErrorMessage
          error={error}
          isGenerating={isGenerating}
          onResend={onResend}
        />
      )}
      {showThinkingIndicator &&
        isGenerating &&
        !hasVisibleContent(messages, shouldShowToolCalls) && (
          <ThinkingIndicator />
        )}
    </>
  );
};
