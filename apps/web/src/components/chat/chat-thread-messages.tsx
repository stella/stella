import { useMemo } from "react";
import type { ComponentProps } from "react";

import { isToolUIPart } from "ai";
import type { FileUIPart } from "ai";
import {
  ClockIcon,
  CopyIcon,
  FileTextIcon,
  PaperclipIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import type { PluggableList } from "unified";
import { useTranslations } from "use-intl";

import { isThirdPartyBoundaryRefusalError } from "@stll/anonymize-chat";
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
import { useChatApproval } from "@/components/chat/chat-approval-context";
import type {
  AskUserOutput,
  ChatAnonRestoration,
  ChatPart,
  ChatUITools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { isApprovalPart } from "@/components/chat/chat-ui-tools";
import { NeedsMatterCard } from "@/components/chat/needs-matter-card";
import { rehypeAnonSpans } from "@/components/chat/rehype-anon-spans";
import { SourceChips } from "@/components/chat/source-chips";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { WebSearchSources } from "@/components/chat/web-search-sources";
import type { TranslationKey } from "@/i18n/types";
import { getUserFileContentUrl } from "@/lib/user-files";
import type { QueuedChatMessage } from "@/routes/_protected.chat/-hooks/use-chat-session";

const USER_STREAMDOWN_COMPONENTS = {
  a: (props: ComponentProps<"a">) => (
    <StreamdownMentionLink interactive={false} {...props} />
  ),
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

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

const EMPTY_RESTORATION_PAIRS: readonly ChatAnonRestoration[] = Object.freeze(
  [],
);

/**
 * Resolve the restoration pairs that match what *this user
 * message* actually sent. Walks forward to the next assistant
 * message (skipping any intervening user messages — the AI SDK
 * persists in chronological order) and uses its server-emitted
 * `data-stella-anon-restorations` pairs, which were produced by
 * the same `PipelineContext` the request body crossed. Returns an
 * empty array while the assistant is still streaming or if the
 * turn was sent raw — both cases render the user message without
 * pills, which matches the audit story (no anonymization → no
 * audit cue).
 */
const getFollowingAssistantRestorations = (
  messages: readonly PersistedChatMessage[],
  userMessageIndex: number,
): readonly ChatAnonRestoration[] => {
  for (let i = userMessageIndex + 1; i < messages.length; i += 1) {
    const candidate = messages[i];
    if (candidate?.role === "assistant") {
      return collectAnonRestorations(candidate.parts);
    }
  }
  return EMPTY_RESTORATION_PAIRS;
};

const getMentionTagAttr = (attrs: string, name: string) => {
  const attrName = escapeRegExp(name);
  const match = new RegExp(
    `(?:^|\\s)${attrName}\\s*=\\s*(["'])(.*?)\\1`,
    "iu",
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
  usage_limit: "chat.sendErrorUsageLimit",
  loop_detected: "chat.sendErrorLoopDetected",
  model_unavailable: "chat.sendErrorModelUnavailable",
  provider_unavailable: "chat.sendErrorProviderUnavailable",
  quota_exhausted: "chat.sendErrorQuotaExhausted",
} as const satisfies Record<string, TranslationKey>;

type ChatErrorTranslationKey =
  | (typeof CHAT_ERROR_TRANSLATION_KEYS)[keyof typeof CHAT_ERROR_TRANSLATION_KEYS]
  | "chat.sendErrorAnonymizationBlocked"
  | "chat.sendError";

const isMappedChatErrorKind = (
  message: string,
): message is keyof typeof CHAT_ERROR_TRANSLATION_KEYS =>
  message in CHAT_ERROR_TRANSLATION_KEYS;

const chatErrorTranslationKey = (error: Error): ChatErrorTranslationKey => {
  if (isThirdPartyBoundaryRefusalError(error)) {
    return "chat.sendErrorAnonymizationBlocked";
  }
  if (isMappedChatErrorKind(error.message)) {
    return CHAT_ERROR_TRANSLATION_KEYS[error.message];
  }
  return "chat.sendError";
};

export const ChatErrorMessage = ({
  error,
  isGenerating,
  onResend,
  onSendWithoutAnonymization,
}: {
  error: Error;
  isGenerating: boolean;
  onResend?:
    | ((options?: ChatResendOptions) => void | PromiseLike<void>)
    | undefined;
  onSendWithoutAnonymization?: (() => void | PromiseLike<void>) | undefined;
}) => {
  const t = useTranslations();
  const canSendWithoutAnonymization =
    onSendWithoutAnonymization !== undefined &&
    isThirdPartyBoundaryRefusalError(error);

  return (
    <Message from="assistant">
      <MessageContent className="bg-destructive/10 border-destructive/20 text-destructive max-w-md rounded-lg border px-3 py-2">
        <p className="text-sm">{t(chatErrorTranslationKey(error))}</p>
        <div className="flex flex-wrap gap-2">
          {canSendWithoutAnonymization && (
            <Button
              disabled={isGenerating}
              onClick={() => {
                void onSendWithoutAnonymization();
              }}
              size="sm"
              variant="destructive-outline"
            >
              {t("chat.sendWithoutAnonymization")}
            </Button>
          )}
          {onResend && (
            <Button
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
        </div>
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
  onResend?:
    | ((options?: ChatResendOptions) => void | PromiseLike<void>)
    | undefined;
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
            void onResend?.({ messageId: message.id });
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
  error?: Error | undefined;
  isGenerating?: boolean | undefined;
  messages: PersistedChatMessage[];
  onResend?:
    | ((options?: ChatResendOptions) => void | PromiseLike<void>)
    | undefined;
  onSendWithoutAnonymization?: (() => void | PromiseLike<void>) | undefined;
  onAskUserSubmit: (
    toolCallId: string,
    output: AskUserOutput,
  ) => void | PromiseLike<void>;
  /**
   * Re-run callback for answered ask-user cards. When omitted,
   * the edit affordance stays hidden — useful for surfaces that
   * shouldn't allow branching the conversation (read-only views,
   * mid-stream, etc.).
   */
  onAskUserEditAndRerun?:
    | ((toolCallId: string, output: AskUserOutput) => void | PromiseLike<void>)
    | undefined;
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
  showThinkingIndicator?: boolean | undefined;
  showToolCallDetails?: boolean | undefined;
  showToolCalls?: boolean | undefined;
  /**
   * Messages the user composed while a response was streaming.
   * Rendered as dimmed "pending" bubbles below the transcript;
   * `useChatSession` dispatches them once the turn finishes.
   */
  queuedMessages?: readonly QueuedChatMessage[] | undefined;
  onRemoveQueuedMessage?: ((id: string) => void) | undefined;
  streamdownComponents: {
    a: (props: ComponentProps<"a">) => React.ReactNode;
    "stll-anon"?: (
      props: ComponentProps<"button"> & { ph?: string },
    ) => React.ReactNode;
  };
  workspaceId?: string | undefined;
};

type ChatResendOptions = {
  messageId?: string | undefined;
};

export const ChatThreadMessages = ({
  approvalPendingMessageId,
  error,
  isGenerating = false,
  messages,
  onResend,
  onSendWithoutAnonymization,
  onAskUserSubmit,
  onAskUserEditAndRerun,
  onCreateDocumentResolve,
  onOpenCreatedDocument,
  showThinkingIndicator = false,
  showToolCallDetails,
  showToolCalls,
  queuedMessages,
  onRemoveQueuedMessage,
  streamdownComponents,
  workspaceId,
}: ChatThreadMessagesProps) => {
  const { activeOrganizationId } = useChatApproval();
  const retryableAssistantMessageId = useMemo(
    () => getRetryableAssistantMessageId(messages),
    [messages],
  );
  const shouldShowToolCalls = showToolCallDetails ?? showToolCalls ?? false;

  return (
    <>
      {messages.map((message, index) => (
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
                  activeOrganizationId={activeOrganizationId}
                  isLatestAssistantMessage={
                    message.id === retryableAssistantMessageId
                  }
                  message={message}
                  onAskUserEditAndRerun={onAskUserEditAndRerun}
                  onAskUserSubmit={onAskUserSubmit}
                  onCreateDocumentResolve={onCreateDocumentResolve}
                  onOpenCreatedDocument={onOpenCreatedDocument}
                  shouldShowToolCalls={shouldShowToolCalls}
                  streamdownComponents={streamdownComponents}
                  workspaceId={workspaceId}
                />
                <SourceChips
                  activeOrganizationId={activeOrganizationId}
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
                {message.parts.map((part, partIndex) =>
                  part.type === "text" ? (
                    <UserMessageText
                      key={`${message.id}-user-text-${partIndex}`}
                      restorationPairs={getFollowingAssistantRestorations(
                        messages,
                        index,
                      )}
                      text={normalizeUserMessageTextForDisplay(part.text)}
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
          onSendWithoutAnonymization={onSendWithoutAnonymization}
        />
      )}
      {showThinkingIndicator &&
        isGenerating &&
        !hasVisibleContent(messages) && <ThinkingIndicator />}
      {onRemoveQueuedMessage &&
        queuedMessages !== undefined &&
        queuedMessages.length > 0 && (
          <QueuedUserMessages
            messages={queuedMessages}
            onRemove={onRemoveQueuedMessage}
          />
        )}
    </>
  );
};

type QueuedUserMessagesProps = {
  messages: readonly QueuedChatMessage[];
  onRemove: (id: string) => void;
};

/**
 * Pending user messages — composed mid-stream and waiting their
 * turn. Rendered below the live transcript as dimmed bubbles so the
 * user can see what is queued and cancel any of it before it sends.
 */
const QueuedUserMessages = ({
  messages,
  onRemove,
}: QueuedUserMessagesProps) => {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground ms-auto flex items-center gap-1 text-xs">
        <ClockIcon aria-hidden="true" className="size-3" />
        {t("chat.queuedNotice")}
      </p>
      {messages.map((queued) => {
        const text = queued.text.trim()
          ? normalizeUserMessageTextForDisplay(queued.text)
          : "";
        return (
          <Message from="user" key={queued.id}>
            <div className="ms-auto flex max-w-full items-start gap-1">
              <Button
                aria-label={t("chat.cancelQueuedMessage")}
                className="mt-0.5 shrink-0"
                onClick={() => onRemove(queued.id)}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
              <MessageContent className="opacity-60">
                {text.length > 0 && (
                  <UserMessageText
                    restorationPairs={EMPTY_RESTORATION_PAIRS}
                    text={text}
                  />
                )}
                {queued.fileCount > 0 && (
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <PaperclipIcon aria-hidden="true" className="size-3" />
                    {t("chat.queuedAttachmentCount", {
                      count: queued.fileCount,
                    })}
                  </span>
                )}
              </MessageContent>
            </div>
          </Message>
        );
      })}
    </div>
  );
};

type AssistantMessagePartsProps = Pick<
  ChatThreadMessagesProps,
  | "onAskUserEditAndRerun"
  | "onAskUserSubmit"
  | "onCreateDocumentResolve"
  | "onOpenCreatedDocument"
  | "streamdownComponents"
  | "workspaceId"
> & {
  activeOrganizationId: string;
  isLatestAssistantMessage: boolean;
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
  activeOrganizationId,
  isLatestAssistantMessage,
  message,
  onAskUserEditAndRerun,
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
              discardsDownstream={!isLatestAssistantMessage}
              key={part.toolCallId}
              {...(onAskUserEditAndRerun && {
                onEditAndRerun: (toolCallId, output) => {
                  void onAskUserEditAndRerun(toolCallId, output);
                },
              })}
              onSubmit={(toolCallId, output) => {
                void onAskUserSubmit(toolCallId, output);
              }}
              part={part}
              restorationPairs={restorationPairs}
              workspaceId={workspaceId}
            />
          );
        }

        if (part.type === "tool-create-document") {
          return (
            <NeedsMatterCard
              key={part.toolCallId}
              onOpenCreated={onOpenCreatedDocument}
              onResolve={onCreateDocumentResolve}
              part={part}
            />
          );
        }

        if (
          (part.type === "tool-web_search" || part.type === "tool-fetch_url") &&
          "state" in part &&
          part.state === "output-available"
        ) {
          // Completed searches are rendered as a single dedup'd row by
          // <WebSearchSources> below; skipping here avoids the duplicate.
          // Other states (approval-requested, input-*) still need to fall
          // through to the approval/tool-call cards.
          return null;
        }

        if (isApprovalPart(part)) {
          return (
            <ToolApprovalCard
              key={part.toolCallId}
              part={part}
              workspaceId={workspaceId}
            />
          );
        }

        if (isToolUIPart(part)) {
          return (
            <ToolCallCard
              activeOrganizationId={activeOrganizationId}
              key={part.toolCallId}
              part={part}
              showDetails={shouldShowToolCalls}
            />
          );
        }

        return null;
      })}
      <WebSearchSources parts={message.parts} />
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
  restorationPairs,
}: {
  text: string;
  /**
   * Server-side placeholder → original pairs from the *following*
   * assistant message's `data-stella-anon-restorations` part.
   * Using those guarantees the pill rendering matches what
   * actually crossed the boundary on this turn: any pair listed
   * here was minted by the server's shared `PipelineContext`, so
   * the placeholder id is accurate. Reading the live store and
   * rerunning the client-side wasm pipeline used to produce both
   * the wrong id (fresh counter) and false positives/negatives
   * after toggling anonymized mode post-send.
   */
  restorationPairs: readonly ChatAnonRestoration[];
}) => {
  const rehypePlugins = useMemo<PluggableList | undefined>(
    () =>
      restorationPairs.length > 0
        ? [[rehypeAnonSpans, restorationPairs]]
        : undefined,
    [restorationPairs],
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
