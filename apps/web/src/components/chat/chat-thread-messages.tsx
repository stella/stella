import { useMemo } from "react";
import type { ComponentProps } from "react";

import { isToolUIPart } from "ai";
import type { FileUIPart } from "ai";
import { CopyIcon, FileTextIcon, RotateCcwIcon } from "lucide-react";
import type { PluggableList } from "unified";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { AnonymizedSpan } from "@/components/chat/anonymized-span";
import { AskUserCard } from "@/components/chat/ask-user-card";
import type {
  ApprovalToolName,
  AskUserOutput,
  ChatAnonRestoration,
  ChatPart,
  ChatUITools,
  PersistedChatMessage,
  ToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";
import { isApprovalPart } from "@/components/chat/chat-ui-tools";
import { NeedsMatterCard } from "@/components/chat/needs-matter-card";
import type { NeedsMatterMatter } from "@/components/chat/needs-matter-card";
import { rehypeAnonSpans } from "@/components/chat/rehype-anon-spans";
import { SourceChips } from "@/components/chat/source-chips";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import type { TranslationKey } from "@/i18n/types";
import { useChatAnonymizeForRender } from "@/lib/anonymize/use-chat-anonymize";
import { useChatAnonymizedStore } from "@/lib/chat-anonymized-store";
import { getUserFileContentUrl } from "@/lib/user-files";

const USER_STREAMDOWN_COMPONENTS = {
  a: (props: ComponentProps<"a">) => (
    <StreamdownMentionLink interactive={false} {...props} />
  ),
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const collectAnonRestorations = (
  parts: readonly ChatPart[],
): readonly ChatAnonRestoration[] => {
  // De-dupe placeholder→original pairs across multiple parts in a
  // single assistant message so the rehype plugin builds one
  // pattern per stream.
  const seen = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "data-stella-anon-restorations") {
      continue;
    }
    for (const pair of part.data.pairs) {
      if (!seen.has(pair.placeholder)) {
        seen.set(pair.placeholder, pair.original);
      }
    }
  }
  return [...seen.entries()].map(([placeholder, original]) => ({
    placeholder,
    original,
  }));
};

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

      if (
        isApprovalPart(part) ||
        part.type === "tool-ask-user" ||
        part.type === "tool-create-document"
      ) {
        return true;
      }

      if (isToolUIPart(part)) {
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
  onResend?: ((messageId?: string) => void | PromiseLike<void>) | undefined;
}) => {
  const t = useTranslations();
  const text = useMemo(() => getMessageText(message), [message]);
  const canRetry = Boolean(
    onResend && isLatestAssistantMessage && !isGenerating,
  );

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
          onClick={() => {
            void onResend?.(message.id);
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
  alwaysApprovedTools: ReadonlySet<ToolApprovalGrant>;
  approvalPendingMessageId: string | null;
  blockedApprovalTools?: ReadonlySet<ApprovalToolName> | undefined;
  conversationApprovedTools: ReadonlySet<ToolApprovalGrant>;
  handleAllowInConversation: (
    id: string,
    toolName: ApprovalToolName,
  ) => void | PromiseLike<void>;
  handleAlwaysAllow: (
    id: string,
    toolName: ApprovalToolName,
  ) => void | PromiseLike<void>;
  handleApprove: (
    id: string,
    toolName: ApprovalToolName,
  ) => void | PromiseLike<void>;
  handleDeny: (id: string) => void | PromiseLike<void>;
  error?: Error | undefined;
  isGenerating?: boolean | undefined;
  messages: PersistedChatMessage[];
  onResend?: ((messageId?: string) => void | PromiseLike<void>) | undefined;
  onAskUserSubmit: (
    toolCallId: string,
    output: AskUserOutput,
  ) => void | PromiseLike<void>;
  onCreateDocumentResolve: (
    toolCallId: string,
    matterId: string,
    input: ChatUITools["create-document"]["input"],
  ) => Promise<void> | void;
  onOpenCreatedDocument: (
    output: Extract<
      ChatUITools["create-document"]["output"],
      { success: true }
    >,
  ) => Promise<void> | void;
  createDocumentMatters: readonly NeedsMatterMatter[];
  isLoadingCreateDocumentMatters: boolean;
  showThinkingIndicator?: boolean | undefined;
  showToolCallDetails?: boolean | undefined;
  showToolCalls?: boolean | undefined;
  streamdownComponents: {
    a: (props: ComponentProps<"a">) => React.ReactNode;
    "stll-anon"?: (
      props: ComponentProps<"button"> & { ph?: string },
    ) => React.ReactNode;
  };
  workspaceId?: string | undefined;
};

export const ChatThreadMessages = ({
  alwaysApprovedTools,
  approvalPendingMessageId,
  blockedApprovalTools,
  conversationApprovedTools,
  handleAllowInConversation,
  handleAlwaysAllow,
  handleApprove,
  handleDeny,
  error,
  isGenerating = false,
  messages,
  onResend,
  onAskUserSubmit,
  onCreateDocumentResolve,
  onOpenCreatedDocument,
  createDocumentMatters,
  isLoadingCreateDocumentMatters,
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
                <AssistantMessageParts
                  alwaysApprovedTools={alwaysApprovedTools}
                  blockedApprovalTools={blockedApprovalTools}
                  conversationApprovedTools={conversationApprovedTools}
                  createDocumentMatters={createDocumentMatters}
                  handleAllowInConversation={handleAllowInConversation}
                  handleAlwaysAllow={handleAlwaysAllow}
                  handleApprove={handleApprove}
                  handleDeny={handleDeny}
                  isLoadingCreateDocumentMatters={
                    isLoadingCreateDocumentMatters
                  }
                  message={message}
                  onAskUserSubmit={onAskUserSubmit}
                  onCreateDocumentResolve={onCreateDocumentResolve}
                  onOpenCreatedDocument={onOpenCreatedDocument}
                  shouldShowToolCalls={shouldShowToolCalls}
                  streamdownComponents={streamdownComponents}
                  workspaceId={workspaceId}
                />
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
                    <UserMessageText
                      key={`${message.id}-user-text-${index}`}
                      text={normalizeUserMessageTextForDisplay(part.text)}
                      workspaceId={workspaceId ?? message.id}
                    />
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
        !hasVisibleContent(messages) && <ThinkingIndicator />}
    </>
  );
};

type AssistantMessagePartsProps = Pick<
  ChatThreadMessagesProps,
  | "alwaysApprovedTools"
  | "blockedApprovalTools"
  | "conversationApprovedTools"
  | "createDocumentMatters"
  | "handleAllowInConversation"
  | "handleAlwaysAllow"
  | "handleApprove"
  | "handleDeny"
  | "isLoadingCreateDocumentMatters"
  | "onAskUserSubmit"
  | "onCreateDocumentResolve"
  | "onOpenCreatedDocument"
  | "streamdownComponents"
  | "workspaceId"
> & {
  message: PersistedChatMessage;
  shouldShowToolCalls: boolean;
};

/**
 * Renders the body of an assistant message. Splitting this out of
 * the parent `messages.map` lets React Compiler memoize the
 * `restorationPairs` snapshot per-message — without the split,
 * `collectAnonRestorations` re-runs on every render in the parent
 * and the resulting array identity churns, forcing Streamdown to
 * remount on every streaming text delta.
 */
const AssistantMessageParts = ({
  alwaysApprovedTools,
  blockedApprovalTools,
  conversationApprovedTools,
  createDocumentMatters,
  handleAllowInConversation,
  handleAlwaysAllow,
  handleApprove,
  handleDeny,
  isLoadingCreateDocumentMatters,
  message,
  onAskUserSubmit,
  onCreateDocumentResolve,
  onOpenCreatedDocument,
  shouldShowToolCalls,
  streamdownComponents,
  workspaceId,
}: AssistantMessagePartsProps) => {
  const restorationPairs = collectAnonRestorations(message.parts);
  return (
    <>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return (
            <AssistantTextPart
              components={streamdownComponents}
              key={`${message.id}-text-${index}`}
              restorationPairs={restorationPairs}
              text={part.text}
            />
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

        if (part.type === "tool-create-document") {
          return (
            <NeedsMatterCard
              isLoadingMatters={isLoadingCreateDocumentMatters}
              key={part.toolCallId}
              matters={createDocumentMatters}
              onOpenCreated={onOpenCreatedDocument}
              onResolve={onCreateDocumentResolve}
              part={part}
            />
          );
        }

        if (isApprovalPart(part)) {
          return (
            <ToolApprovalCard
              alwaysApprovedTools={alwaysApprovedTools}
              blockedApprovalTools={blockedApprovalTools}
              conversationApprovedTools={conversationApprovedTools}
              key={part.toolCallId}
              onAllowInConversation={handleAllowInConversation}
              onAlwaysAllow={handleAlwaysAllow}
              onApprove={handleApprove}
              onDeny={handleDeny}
              part={part}
              workspaceId={workspaceId}
            />
          );
        }

        if (isToolUIPart(part)) {
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
    </>
  );
};

const AssistantTextPart = ({
  components,
  restorationPairs,
  text,
}: {
  components: ChatThreadMessagesProps["streamdownComponents"];
  restorationPairs: readonly ChatAnonRestoration[];
  text: string;
}) => {
  // Stable identity so MessageResponse memo can short-circuit when
  // nothing actually changed; recomputes only when the pairs array
  // identity changes (i.e. a fresh stream emitted new restorations).
  const rehypePlugins = useMemo<PluggableList | undefined>(
    () =>
      restorationPairs.length > 0
        ? [[rehypeAnonSpans, restorationPairs]]
        : undefined,
    [restorationPairs],
  );
  if (rehypePlugins === undefined) {
    return <MessageResponse components={components}>{text}</MessageResponse>;
  }
  return (
    <MessageResponse components={components} rehypePlugins={rehypePlugins}>
      {text}
    </MessageResponse>
  );
};

const USER_TEXT_STREAMDOWN_COMPONENTS = {
  ...USER_STREAMDOWN_COMPONENTS,
  "stll-anon": (props: ComponentProps<"button"> & { ph?: string }) => (
    <AnonymizedSpan {...props} />
  ),
};

const UserMessageText = ({
  text,
  workspaceId,
}: {
  text: string;
  workspaceId: string;
}) => {
  // Read the global preference directly so we don't need to thread
  // `anonymized` through every parent — the store is a single
  // boolean, not per-thread, since the v0.1.6 store rewrite.
  const anonymized = useChatAnonymizedStore((s) => s.anonymized);
  const pairs = useChatAnonymizeForRender({
    enabled: anonymized,
    text,
    workspaceId,
  });
  // Memoise so MessageResponse's identity-based memo can short-
  // circuit on subsequent renders. `pairs` itself comes from
  // TanStack Query and is stable across renders.
  const rehypePlugins = useMemo<PluggableList | undefined>(
    () => (pairs.length > 0 ? [[rehypeAnonSpans, pairs]] : undefined),
    [pairs],
  );
  if (rehypePlugins === undefined) {
    return (
      <MessageResponse components={USER_TEXT_STREAMDOWN_COMPONENTS}>
        {text}
      </MessageResponse>
    );
  }
  return (
    <MessageResponse
      components={USER_TEXT_STREAMDOWN_COMPONENTS}
      rehypePlugins={rehypePlugins}
    >
      {text}
    </MessageResponse>
  );
};
