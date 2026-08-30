import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";

import {
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  FileTextIcon,
  Loader2Icon,
  PaperclipIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import type { PluggableList } from "unified";
import { useTranslations } from "use-intl";

import { isThirdPartyBoundaryRefusalError } from "@stll/anonymize-chat";
import type { AIErrorKind } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { AnonymizedSpan } from "@/components/chat/anonymized-span";
import { AskUserCard } from "@/components/chat/ask-user-card";
import { ChatActivityOrb } from "@/components/chat/chat-activity-orb";
import {
  getLatestCompletedResearchPartIndex,
  resolveChatActivityIndicatorState,
} from "@/components/chat/chat-activity.logic";
import { useChatApproval } from "@/components/chat/chat-approval-context";
import { ChatImageAttachment } from "@/components/chat/chat-image-attachment";
import {
  ChatRichMessagePart,
  isRichChatPart,
} from "@/components/chat/chat-rich-message-part";
import type { RichChatPart } from "@/components/chat/chat-rich-message-part";
import {
  assistantMessageFallbackText,
  buildMessageTurns,
  collectAnonRestorations,
  DATA_URL_PREFIX,
  decodeBase64DataUrl,
  EMPTY_RESTORATION_PAIRS,
  getFollowingAssistantRestorations,
  getMentionTagAttr,
  userMessageFallbackText,
} from "@/components/chat/chat-thread-messages.logic";
import type {
  AskUserOutput,
  ChatAnonRestoration,
  ChatAttachmentPart,
  ChatPart,
  ChatUIMessage,
  ChatUIPart,
  ChatUITools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import {
  getChatToolTitleKey,
  hasRunningToolCallInLatestAssistantMessage,
  isApprovalPart,
  isOpaquePersistedChatToolCallPart,
} from "@/components/chat/chat-ui-tools";
import type { CreateDocumentDraft } from "@/components/chat/create-document-draft.logic";
import { MessageExportMenu } from "@/components/chat/message-export-menu";
import { findCreateDocumentArtifactForMessage } from "@/components/chat/message-export-menu.logic";
import { NeedsMatterCard } from "@/components/chat/needs-matter-card";
import type { CreateDocumentDestination } from "@/components/chat/needs-matter-card";
import { rehypeAnonSpans } from "@/components/chat/rehype-anon-spans";
import { SourceChips } from "@/components/chat/source-chips";
import { SpawnSubagentsCard } from "@/components/chat/spawn-subagents-card";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { WebSearchSources } from "@/components/chat/web-search-sources";
import type { QueuedChatMessage } from "@/features/chat/hooks/use-chat-session";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useMaybeStickToBottomContext } from "@/hooks/use-stick-to-bottom";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { dedupeById } from "@/lib/dedupe-by-id";
import { detached } from "@/lib/detached";
import { sanitizeHref } from "@/lib/sanitize-href";
import {
  getUserFileContentUrl,
  getUserFileThumbnailUrl,
} from "@/lib/user-files";
import { downloadFile } from "@/lib/utils";

export const ChatThreadMessages = ({
  activeFileName,
  assistantTextDensity = "default",
  approvalPendingMessageId,
  error,
  hasOlderMessages = false,
  isGenerating = false,
  isLoadingOlder = false,
  loadOlderError = false,
  messages: rawMessages,
  onLoadOlder,
  scrollContainerRef,
  onResend,
  onSendWithoutAnonymization,
  onAskUserSubmit,
  onAskUserEditAndRerun,
  onAskUserEditingChange,
  onCreateDocumentResolve,
  onOpenCreateDocumentDraft,
  onOpenCreatedDocument,
  showThinkingIndicator = false,
  showToolCallDetails,
  showToolCalls,
  stickyUserMessages = false,
  queuedMessages,
  onRemoveQueuedMessage,
  streamdownComponents,
  threadRef,
  workspaceId,
}: ChatThreadMessagesProps) => {
  const { activeOrganizationId } = useChatApproval();
  // The transcript can briefly hold both the optimistic streamed copy and the
  // persisted copy of one message during the per-turn refetch handoff; both
  // carry the same id, so React would render it twice. Collapse by id before
  // any downstream read.
  const messages = useMemo(() => dedupeById(rawMessages), [rawMessages]);
  const generationActive = error === undefined && isGenerating;
  const retryableAssistantMessageId = useMemo(
    () => getRetryableAssistantMessageId(messages),
    [messages],
  );
  const shouldShowToolCalls = showToolCallDetails ?? showToolCalls ?? false;
  const latestCompletedResearchPartIndex =
    getLatestCompletedResearchPartIndex(messages);
  const activityIndicatorState = resolveChatActivityIndicatorState({
    hasCompletedResearch: latestCompletedResearchPartIndex !== null,
    hasRunningTool: hasRunningToolCallInLatestAssistantMessage({ messages }),
    hasVisibleResponse: hasVisibleResponseContent(
      messages,
      latestCompletedResearchPartIndex,
    ),
    hasVisibleContent: hasVisibleContent(messages),
  });

  // Null when this list renders outside a `Conversation` (the file-chat
  // overlay uses its own scroll container and never wires load-older).
  const stick = useMaybeStickToBottomContext();
  const scrollRef = scrollContainerRef ?? stick?.scrollElementRef ?? null;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const firstMessageId = messages.at(0)?.id ?? null;
  const prevFirstMessageIdRef = useRef(firstMessageId);
  // Scroll height captured the instant a load-older request fires,
  // before the prepend grows the container above the viewport. Set
  // back to null once consumed so only a genuine prepend (not a
  // bottom-append/stream or a thread switch) restores scroll.
  const anchorScrollHeightRef = useRef<number | null>(null);
  const canLoadOlder = hasOlderMessages && onLoadOlder !== undefined;

  const triggerLoadOlder = useLatestCallback(() => {
    const container = scrollRef?.current;
    if (container) {
      anchorScrollHeightRef.current = container.scrollHeight;
    }
    detached(onLoadOlder?.(), "chat-thread-messages.load-older");
  });

  // Drive the trigger from a top sentinel: when it scrolls into view
  // (with a buffer) and an older page exists, fetch it. The observer
  // re-arms each render so it tracks the latest `canLoadOlder` /
  // `isLoadingOlder` without firing while a fetch is in flight.
  useExternalSyncEffect(() => {
    const root = scrollRef?.current;
    const target = sentinelRef.current;
    if (
      !root ||
      !target ||
      !hasOlderMessages ||
      onLoadOlder === undefined ||
      isLoadingOlder ||
      loadOlderError
    ) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(0);
        if (!entry?.isIntersecting) {
          return;
        }
        triggerLoadOlder();
      },
      { root, rootMargin: "240px 0px 0px 0px" },
    );

    observer.observe(target);
    return () => observer.disconnect();
    // Re-arm on paging state AND when the bound load callback changes: its
    // identity changes on thread switch, so this stops the observer from
    // fetching the previous thread's older page into the current transcript.
    // `loadOlderError` keeps the observer detached after a failure so it
    // cannot loop the request; the manual button is the only retry path.
  }, [
    hasOlderMessages,
    isLoadingOlder,
    loadOlderError,
    onLoadOlder,
    scrollRef,
    triggerLoadOlder,
  ]);

  // Scroll anchoring: a prepend changes the first message id and grows
  // scrollHeight above the viewport. Restore the previous offset before
  // paint so the message under the user's eye stays put. Bottom-appends
  // and streaming keep the first id, so they skip this and stick-to-
  // bottom handles them; a thread switch changes the id too but has no
  // captured anchor, so it is also skipped.
  // eslint-disable-next-line react/react-compiler -- scroll anchoring mutates the forwarded DOM scroll container in a layout effect
  useLayoutEffect(() => {
    const previousFirstId = prevFirstMessageIdRef.current;
    prevFirstMessageIdRef.current = firstMessageId;
    const previousScrollHeight = anchorScrollHeightRef.current;
    anchorScrollHeightRef.current = null;
    if (previousFirstId === firstMessageId || previousScrollHeight === null) {
      return;
    }
    const container = scrollRef?.current;
    if (!container) {
      return;
    }
    // eslint-disable-next-line react/react-compiler -- adjust the forwarded DOM node after a prepend to preserve the viewport anchor
    container.scrollTop += container.scrollHeight - previousScrollHeight;
  }, [firstMessageId, scrollRef]);

  // Rendered per message in both the flat and sticky layouts, so the message
  // body markup stays identical across surfaces; only the surrounding turn
  // grouping differs when `stickyUserMessages` is on.
  const renderMessageNode = (message: ChatUIMessage, index: number) => (
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
              activeFileName={activeFileName}
              activeOrganizationId={activeOrganizationId}
              assistantTextDensity={assistantTextDensity}
              isGenerating={generationActive}
              isLatestAssistantMessage={
                message.id === retryableAssistantMessageId
              }
              message={message}
              onAskUserEditAndRerun={onAskUserEditAndRerun}
              onAskUserEditingChange={onAskUserEditingChange}
              onAskUserSubmit={onAskUserSubmit}
              onCreateDocumentResolve={onCreateDocumentResolve}
              onOpenCreateDocumentDraft={onOpenCreateDocumentDraft}
              onOpenCreatedDocument={onOpenCreatedDocument}
              shouldShowToolCalls={shouldShowToolCalls}
              streamdownComponents={streamdownComponents}
              workspaceId={workspaceId}
            />
            <SourceChips
              activeOrganizationId={activeOrganizationId}
              messageId={message.id}
              parts={message.parts}
              sourceDocuments={message.metadata?.sourceDocuments}
              workspaceId={workspaceId}
            />
            <AssistantMessageActions
              exportArtifact={findCreateDocumentArtifactForMessage(
                messages,
                index,
              )}
              isGenerating={generationActive}
              isLatestAssistantMessage={
                message.id === retryableAssistantMessageId
              }
              message={message}
              onResend={onResend}
              threadRef={threadRef}
            />
          </>
        ) : (
          <>
            {(() => {
              const fileParts: ChatAttachmentPart[] = [];
              for (const part of message.parts) {
                if (isChatAttachmentPart(part)) {
                  fileParts.push(part);
                }
              }

              return <UserAttachments parts={fileParts} />;
            })()}
            {message.parts.map((part, partIndex) =>
              part.type === "text" ? (
                <UserMessageText
                  // eslint-disable-next-line react/no-array-index-key -- message.parts is append-only during streaming (never reordered/removed); index only disambiguates parts within this single message.
                  key={`${message.id}-user-text-${partIndex}`}
                  restorationPairs={getFollowingAssistantRestorations(
                    messages,
                    index,
                  )}
                  text={normalizeUserMessageTextForDisplay(part.content)}
                />
              ) : null,
            )}
          </>
        )}
      </MessageContent>
    </Message>
  );

  return (
    <>
      {canLoadOlder && (
        <LoadOlderSentinel
          isLoadingOlder={isLoadingOlder}
          onLoadOlder={triggerLoadOlder}
          ref={sentinelRef}
        />
      )}
      {stickyUserMessages
        ? buildMessageTurns(messages).map((turn, turnIndex) => {
            if (turn.type === "orphan") {
              const orphanFirstMessageId = turn.body.at(0)?.message.id;
              return (
                <Fragment key={orphanFirstMessageId ?? `orphan-${turnIndex}`}>
                  {turn.body.map((item) =>
                    renderMessageNode(item.message, item.index),
                  )}
                </Fragment>
              );
            }
            return (
              <StickyUserTurn
                approvalPendingMessageId={approvalPendingMessageId}
                headerIndex={turn.index}
                headerMessage={turn.header}
                key={turn.header.id}
                messages={messages}
                scrollRef={scrollRef}
              >
                {turn.body.map((item) =>
                  renderMessageNode(item.message, item.index),
                )}
              </StickyUserTurn>
            );
          })
        : messages.map((message, index) => renderMessageNode(message, index))}
      {error && (
        <ChatErrorMessage
          error={error}
          isGenerating={generationActive}
          onResend={onResend}
          onSendWithoutAnonymization={onSendWithoutAnonymization}
        />
      )}
      {showThinkingIndicator && generationActive && activityIndicatorState && (
        <ThinkingIndicator state={activityIndicatorState} />
      )}
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

type StickyUserTurnProps = {
  approvalPendingMessageId: string | null;
  headerIndex: number;
  headerMessage: PersistedChatMessage;
  messages: readonly PersistedChatMessage[];
  scrollRef: RefObject<HTMLDivElement | null> | null;
  children: ReactNode;
};

const STICKY_USER_HEADER_NATURAL_HEIGHT_VAR =
  "--sticky-user-header-natural-height";

/**
 * One turn in the sticky layout: a user header pinned to the top of the
 * scroll container while its answer scrolls beneath. The header only sticks
 * within this `section`, so once the answer is fully scrolled past the next
 * turn's header takes over.
 */
const StickyUserTurn = ({
  approvalPendingMessageId,
  headerIndex,
  headerMessage,
  messages,
  scrollRef,
  children,
}: StickyUserTurnProps) => {
  const t = useTranslations();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const [isStuck, setIsStuck] = useState(false);
  const restorationPairs = getFollowingAssistantRestorations(
    messages,
    headerIndex,
  );
  const fileParts: ChatAttachmentPart[] = [];
  for (const part of headerMessage.parts) {
    if (isChatAttachmentPart(part)) {
      fileParts.push(part);
    }
  }
  // A file-only turn (attachments, no visible text) would pin as an empty
  // bubble once stuck, because the full attachments row hides while stuck and
  // there is no text clamp to fall back on. Keep a compact count chip in that
  // case so the pinned context is never blank; turns that have text keep the
  // current behavior (attachments hidden, text clamped).
  const hasVisibleText = headerMessage.parts.some(
    (part) => part.type === "text" && part.content.trim().length > 0,
  );

  // The compact pinned header must be a visual change only. If collapsing
  // its text also changes this turn's in-flow height, Chrome's scroll
  // anchoring moves the sentinel back below the sticky boundary; that
  // immediately expands the header again and creates a render/scroll loop.
  // Capture the natural height before paint, then keep that outer layout box
  // stable while the inner pinned chrome becomes compact.
  useLayoutEffect(() => {
    const header = stickyHeaderRef.current;
    if (!header) {
      return;
    }
    header.style.setProperty(
      STICKY_USER_HEADER_NATURAL_HEIGHT_VAR,
      `${String(header.offsetHeight)}px`,
    );
  }, [headerMessage.id]);

  useExternalSyncEffect(() => {
    const header = stickyHeaderRef.current;
    if (!header) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      if (header.dataset["stuck"] !== "false") {
        return;
      }
      header.style.setProperty(
        STICKY_USER_HEADER_NATURAL_HEIGHT_VAR,
        `${String(header.offsetHeight)}px`,
      );
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [headerMessage.id]);

  // Stuck-detection: an out-of-flow 1px sentinel marks the header's natural
  // top. Once it scrolls above the container's top edge the header is pinned.
  // Re-armed on `headerMessage.id` so a thread switch or paginated prepend
  // rebinds the observer to this turn's live sentinel and container.
  useExternalSyncEffect(() => {
    const root = scrollRef?.current;
    const target = sentinelRef.current;
    if (!root || !target) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(0);
        if (!entry) {
          return;
        }
        const rootTop = entry.rootBounds?.top ?? 0;
        setIsStuck(
          !entry.isIntersecting && entry.boundingClientRect.top <= rootTop,
        );
      },
      { root, rootMargin: "0px", threshold: [0] },
    );
    observer.observe(target);
    return () => observer.disconnect();
    // scrollRef/sentinelRef are stable refs; headerMessage.id re-arms on
    // thread switch or prepend.
  }, [scrollRef, headerMessage.id]);

  // Scroll the header back to its natural position. The header itself is
  // pinned at the top when stuck, so scrolling it into view is a no-op;
  // aligning the always-in-flow sentinel to the container top is what
  // reveals the start of this turn.
  const handleScrollBack = () => {
    const container = scrollRef?.current;
    const sentinel = sentinelRef.current;
    if (!container || !sentinel) {
      return;
    }
    // eslint-disable-next-line react/react-compiler -- imperative scroll of the container DOM node (reached through the forwarded scrollRef prop) inside a click handler; a legitimate event-handler DOM mutation, not render state
    container.scrollTop +=
      sentinel.getBoundingClientRect().top -
      container.getBoundingClientRect().top;
  };

  return (
    <section
      className="relative flex flex-col gap-3"
      data-chat-turn-id={headerMessage.id}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        ref={sentinelRef}
      />
      <div
        className={cn(
          // Only needs to cover in-flow transcript content scrolling beneath
          // it (z-auto). The page-level stacking order (see chat-thread-page)
          // keeps the floating composer above the whole transcript, so this
          // must NOT climb high enough to overlay it. `z-10` is the ceiling.
          "group/sticky sticky top-0 z-10",
          // Preserve the natural in-flow height while pinned. The compact
          // chrome below owns its own paint, so the transparent remainder
          // neither hides nor intercepts the answer scrolling underneath.
          "data-[stuck=true]:pointer-events-none data-[stuck=true]:h-(--sticky-user-header-natural-height)",
        )}
        data-stuck={isStuck ? "true" : "false"}
        ref={stickyHeaderRef}
      >
        <div
          className={cn(
            "pointer-events-auto relative",
            // Unstuck: opaque band flush with the page (no chrome/box).
            "group-data-[stuck=false]/sticky:bg-background",
            // Stuck: near-opaque compact glass shelf. Keeping these styles
            // on the inner chrome leaves the height-preserving outer box
            // transparent below the visible pinned message.
            "group-data-[stuck=true]/sticky:bg-background/95 supports-[backdrop-filter]:group-data-[stuck=true]/sticky:bg-background/80 group-data-[stuck=true]/sticky:backdrop-blur-md",
            "group-data-[stuck=true]/sticky:border-border/50 group-data-[stuck=true]/sticky:rounded-b-xl group-data-[stuck=true]/sticky:border-b group-data-[stuck=true]/sticky:pt-1",
          )}
        >
          {/* Behind the bubble: while stuck the bubble goes
              pointer-events-none so plain text falls through to this jump
              target, and only its interactive children re-enable clicks. */}
          {isStuck && (
            <button
              aria-label={t("chat.jumpToMessage")}
              className="absolute inset-0 z-0 cursor-pointer"
              onClick={handleScrollBack}
              type="button"
            />
          )}
          <Message
            className={cn(
              "relative z-10 transition-opacity duration-200",
              approvalPendingMessageId &&
                approvalPendingMessageId !== headerMessage.id &&
                "opacity-40",
              "group-data-[stuck=true]/sticky:pointer-events-none",
              "group-data-[stuck=true]/sticky:[&_a]:pointer-events-auto",
              "group-data-[stuck=true]/sticky:[&_button]:pointer-events-auto",
            )}
            from="user"
          >
            <MessageContent>
              <div className="group-data-[stuck=true]/sticky:hidden">
                <UserAttachments parts={fileParts} />
              </div>
              {!hasVisibleText && fileParts.length > 0 && (
                <span className="text-muted-foreground hidden items-center gap-1 text-xs group-data-[stuck=true]/sticky:flex">
                  <PaperclipIcon aria-hidden="true" className="size-3" />
                  {t("chat.queuedAttachmentCount", { count: fileParts.length })}
                </span>
              )}
              <div
                className={cn(
                  "group-data-[stuck=true]/sticky:max-h-11 group-data-[stuck=true]/sticky:overflow-hidden",
                  // Fade the clipped overflow so a long pinned message dissolves
                  // instead of ending in a hard mid-glyph cut. The absolute-length
                  // stop (~one line-height) keeps a single-line message wholly
                  // inside the opaque zone so it stays fully visible; the fade only
                  // bites once a second line overflows.
                  "group-data-[stuck=true]/sticky:[mask-image:linear-gradient(to_bottom,black_1.25rem,transparent)]",
                )}
              >
                {headerMessage.parts.map((part, partIndex) =>
                  part.type === "text" ? (
                    <UserMessageText
                      // eslint-disable-next-line react/no-array-index-key -- message.parts is append-only during streaming (never reordered/removed); index only disambiguates parts within this single message.
                      key={`${headerMessage.id}-user-text-${partIndex}`}
                      restorationPairs={restorationPairs}
                      text={normalizeUserMessageTextForDisplay(part.content)}
                    />
                  ) : null,
                )}
              </div>
            </MessageContent>
          </Message>
        </div>
      </div>
      {children}
    </section>
  );
};

type LoadOlderSentinelProps = {
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  ref: React.Ref<HTMLDivElement>;
};

/**
 * Top-of-list paging affordance. The `div` is the IntersectionObserver
 * target that auto-loads when scrolled near; the button is the manual,
 * keyboard-accessible fallback. While a page is in flight it shows a
 * spinner instead so the observer (re-armed only when idle) cannot
 * stack requests.
 */
const LoadOlderSentinel = ({
  isLoadingOlder,
  onLoadOlder,
  ref,
}: LoadOlderSentinelProps) => {
  const t = useTranslations();

  return (
    <div className="flex justify-center py-1" ref={ref}>
      {isLoadingOlder ? (
        <span className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
          {t("chat.loadingEarlierMessages")}
        </span>
      ) : (
        <Button onClick={onLoadOlder} size="sm" variant="ghost">
          {t("chat.loadEarlierMessages")}
        </Button>
      )}
    </div>
  );
};

const USER_STREAMDOWN_COMPONENTS = {
  a: (props: ComponentProps<"a">) => (
    <StreamdownMentionLink interactive={false} {...props} />
  ),
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

const IMAGE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const isChatAttachmentPart = (part: ChatPart): part is ChatAttachmentPart =>
  part.type === "image" || part.type === "document";

const getAttachmentUrl = (part: ChatAttachmentPart): string =>
  part.source.value;

const getAttachmentMimeType = (part: ChatAttachmentPart): string =>
  "mimeType" in part.source && typeof part.source.mimeType === "string"
    ? part.source.mimeType
    : "application/octet-stream";

const getAttachmentFilename = (part: ChatAttachmentPart): string | undefined =>
  part.metadata?.filename;

const getAttachmentPlaceholder = (
  part: ChatAttachmentPart,
): string | undefined => part.metadata?.placeholder;

type DownloadDataAttachmentOptions = {
  errorTitle: string;
  fileName: string;
  mimeType: string;
  url: string;
};

const downloadDataAttachment = ({
  errorTitle,
  fileName,
  mimeType,
  url,
}: DownloadDataAttachmentOptions): void => {
  const decoded = decodeBase64DataUrl(url);
  if (decoded.isErr()) {
    getAnalytics().captureError(decoded.error);
    stellaToast.add({ title: errorTitle, type: "error" });
    return;
  }

  downloadFile(new Blob([decoded.value], { type: mimeType }), fileName);
};

const UserAttachments = ({
  parts,
}: {
  parts: readonly ChatAttachmentPart[];
}) => {
  const t = useTranslations();

  if (parts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {parts.map((part, index) => {
        const url = getAttachmentUrl(part);
        const filename = getAttachmentFilename(part);
        const mimeType = getAttachmentMimeType(part);
        const key = `${filename ?? "attachment"}-${index}`;
        const contentUrl = getUserFileContentUrl(url) ?? url;
        const fallbackLabel = t("chat.attachment");
        if (IMAGE_MEDIA_TYPES.includes(mimeType)) {
          // The backend sets `placeholder` (a blur data URL) only when a
          // thumbnail was generated, so its presence doubles as "serve the
          // smaller thumbnail instead of the full original."
          const placeholder = getAttachmentPlaceholder(part);
          const imageSrc = placeholder
            ? (getUserFileThumbnailUrl(url) ?? contentUrl)
            : contentUrl;
          return (
            <ChatImageAttachment
              alt={filename ?? t("chat.attachedImage")}
              fullSrc={contentUrl}
              key={key}
              thumbnailSrc={imageSrc}
              thumbnailStyle={
                placeholder
                  ? {
                      backgroundImage: `url("${placeholder}")`,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                    }
                  : undefined
              }
            />
          );
        }

        const attachmentContent = (
          <>
            <FileTextIcon className="size-3" />
            <span>{filename ?? fallbackLabel}</span>
          </>
        );
        const attachmentClassName = cn(
          "flex items-center gap-1.5",
          "bg-muted/50 rounded-md px-2 py-1",
          "text-muted-foreground text-xs",
        );

        if (contentUrl.startsWith(DATA_URL_PREFIX)) {
          return (
            <button
              className={attachmentClassName}
              key={key}
              onClick={() =>
                downloadDataAttachment({
                  errorTitle: t("errors.actionFailed"),
                  fileName: filename ?? fallbackLabel,
                  mimeType,
                  url: contentUrl,
                })
              }
              type="button"
            >
              {attachmentContent}
            </button>
          );
        }

        return (
          <a
            className={attachmentClassName}
            href={sanitizeHref(contentUrl)}
            key={key}
            rel="noreferrer"
            target="_blank"
          >
            {attachmentContent}
          </a>
        );
      })}
    </div>
  );
};

const ThinkingIndicator = ({ state }: { state: "solving" | "working" }) => {
  const t = useTranslations();

  return (
    <Message from="assistant">
      <MessageContent>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <ChatActivityOrb state={state} />
          <span>
            {t(state === "solving" ? "chat.analyzingSources" : "chat.thinking")}
          </span>
        </div>
      </MessageContent>
    </Message>
  );
};

type MappedChatErrorKind = Exclude<AIErrorKind, "unknown">;

// The backend's chat stream returns an AIErrorKind as the error message.
// Unknown and non-AI errors deliberately fall through to generic copy.
const CHAT_ERROR_TRANSLATION_KEYS = {
  provider_billing: "chat.sendErrorProviderBilling",
  empty_completion: "chat.sendErrorEmptyCompletion",
  loop_detected: "chat.sendErrorLoopDetected",
  model_unavailable: "chat.sendErrorModelUnavailable",
  provider_credentials_rejected: "chat.sendErrorProviderCredentialsRejected",
  provider_unavailable: "chat.sendErrorProviderUnavailable",
  quota_exhausted: "chat.sendErrorQuotaExhausted",
} as const satisfies Record<MappedChatErrorKind, TranslationKey>;

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
                detached(
                  onSendWithoutAnonymization(),
                  "chat-thread-messages.send-without-anonymization",
                );
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
                detached(onResend(), "chat-thread-messages.resend");
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
      if (part.type === "text" && part.content.trim()) {
        return true;
      }

      if (part.type === "tool-call") {
        return true;
      }

      if (part.type === "thinking" && part.content.trim()) {
        return true;
      }

      if (isRichChatPart(part)) {
        return true;
      }
    }
  }

  return false;
};

const hasVisibleResponseContent = (
  messages: readonly PersistedChatMessage[],
  afterPartIndex: number | null,
): boolean => {
  const message = messages.at(-1);
  if (message?.role !== "assistant") {
    return false;
  }

  return message.parts
    .slice((afterPartIndex ?? -1) + 1)
    .some(
      (part) =>
        (part.type === "text" && part.content.trim().length > 0) ||
        (part.type === "thinking" && part.content.trim().length > 0) ||
        isRichChatPart(part),
    );
};

const getMessageText = (message: PersistedChatMessage) => {
  const textParts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.content.trim()) {
      textParts.push(part.content);
    }
  }

  return textParts.join("\n\n").trim();
};

const AssistantMessageActions = ({
  exportArtifact,
  isGenerating,
  isLatestAssistantMessage,
  message,
  onResend,
  threadRef,
}: {
  exportArtifact: CreateDocumentDraft | null;
  isGenerating: boolean;
  isLatestAssistantMessage: boolean;
  message: PersistedChatMessage;
  onResend?:
    | ((options?: ChatResendOptions) => void | PromiseLike<void>)
    | undefined;
  /** Present on the main chat surface; enables the export action. Omitted on
   *  embedded surfaces (file-chat overlay, template studio) that don't export. */
  threadRef?: ChatThreadRef | undefined;
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
    } catch (error) {
      getAnalytics().captureError(error);
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
            detached(handleCopy(), "chat-thread-messages.copy");
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
            detached(
              onResend?.({ messageId: message.id }),
              "chat-thread-messages.resend",
            );
          }}
          size="xs"
          variant="ghost"
        >
          <RotateCcwIcon className="size-3.5" />
          {t("common.retry")}
        </Button>
      )}
      {(!isGenerating || !isLatestAssistantMessage) && text && threadRef && (
        <MessageExportMenu
          artifact={exportArtifact ?? undefined}
          key={`${message.id}:${exportArtifact?.toolCallId ?? "message-only"}`}
          message={message}
          threadRef={threadRef}
        />
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
  /**
   * The active file's display name, when one is open (the DOCX/PDF file
   * overlay). Threaded down to `ToolApprovalCard` so an
   * `edit_workspace_document` approval can show which document the edits
   * target; surfaces with no active file (main chat, Template Studio,
   * inspector) omit it and the card falls back to a generic summary.
   */
  activeFileName?: string | undefined;
  /** Compact prose is reserved for constrained overlays over a document. */
  assistantTextDensity?: "compact" | "default" | undefined;
  approvalPendingMessageId: string | null;
  error?: Error | undefined;
  /** Whether an older page exists to load above the current top. */
  hasOlderMessages?: boolean | undefined;
  isGenerating?: boolean | undefined;
  /** True while an older page is being fetched + prepended. */
  isLoadingOlder?: boolean | undefined;
  /** True after an older-page fetch failed; pauses the auto-trigger so the
   *  sentinel cannot loop the request (the manual button still retries). */
  loadOlderError?: boolean | undefined;
  messages: ChatUIMessage[];
  /** Explicit scroll container for surfaces that render outside a
   *  `Conversation`/StickToBottom provider (e.g. the file-chat overlay);
   *  falls back to the StickToBottom context when omitted. */
  scrollContainerRef?: RefObject<HTMLDivElement | null> | undefined;
  /** Fetch + prepend the page immediately older than the current top. */
  onLoadOlder?: (() => void | PromiseLike<void>) | undefined;
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
  /** Mirrors an ask-user card's local edit-mode up to the page so it can
   *  keep treating a reopened answered card as a live clarification. */
  onAskUserEditingChange?:
    | ((toolCallId: string, isEditing: boolean) => void)
    | undefined;
  onCreateDocumentResolve: (
    toolCallId: string,
    destination: CreateDocumentDestination,
    input: ChatUITools["create-document"]["input"],
  ) => Promise<void> | void;
  onOpenCreateDocumentDraft?: ((toolCallId: string) => void) | undefined;
  onOpenCreatedDocument: (
    output: Extract<
      ChatUITools["create-document"]["output"],
      { entityId: string }
    >,
  ) => Promise<void> | void;
  showThinkingIndicator?: boolean | undefined;
  showToolCallDetails?: boolean | undefined;
  showToolCalls?: boolean | undefined;
  /**
   * Opt-in Cursor-style transcript: each user message pins to the top of
   * the scroll container while its turn's answer scrolls beneath it, the
   * next turn's message pushing it away. Only the main chat surface enables
   * this; every other embedder keeps the flat, non-sticky list.
   */
  stickyUserMessages?: boolean | undefined;
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
  /** The thread being rendered. Enables the per-message export action; omitted
   *  on embedded surfaces that don't offer export. */
  threadRef?: ChatThreadRef | undefined;
  workspaceId?: string | undefined;
};

type ChatResendOptions = {
  messageId?: string | undefined;
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
      <p className="text-muted-foreground flex items-center gap-1 text-xs">
        <ClockIcon aria-hidden="true" className="size-3" />
        {t("chat.queuedNotice")}
      </p>
      {messages.map((queued) => {
        const text = queued.text.trim()
          ? normalizeUserMessageTextForDisplay(queued.text)
          : "";
        return (
          <Message from="user" key={queued.id}>
            <div className="flex w-full items-start gap-1">
              <MessageContent className="min-w-0 flex-1 opacity-60">
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
              <Button
                aria-label={t("chat.cancelQueuedMessage")}
                className="mt-0.5 shrink-0"
                onClick={() => onRemove(queued.id)}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </Message>
        );
      })}
    </div>
  );
};

type AssistantMessagePartsProps = Pick<
  ChatThreadMessagesProps,
  | "activeFileName"
  | "onAskUserEditAndRerun"
  | "onAskUserEditingChange"
  | "onAskUserSubmit"
  | "onCreateDocumentResolve"
  | "onOpenCreateDocumentDraft"
  | "onOpenCreatedDocument"
  | "streamdownComponents"
  | "workspaceId"
> & {
  activeOrganizationId: string;
  assistantTextDensity: "compact" | "default";
  isGenerating: boolean;
  isLatestAssistantMessage: boolean;
  message: ChatUIMessage;
  shouldShowToolCalls: boolean;
};

type AssistantPartRenderEntry =
  | { type: "rich"; key: string; part: RichChatPart }
  | {
      type: "standard";
      part: Exclude<ChatUIPart, RichChatPart>;
    };

const richPartRenderIdentity = (part: RichChatPart): string => {
  if (part.type === "ui-resource") {
    return `ui-resource:${part.toolCallId}`;
  }

  const { source } = part;
  const edgeChars = 32;
  return [
    part.type,
    source.type,
    source.mimeType ?? "",
    source.value.length,
    source.value.slice(0, edgeChars),
    source.value.slice(-edgeChars),
  ].join(":");
};

const toAssistantPartRenderEntries = (
  parts: readonly ChatUIPart[],
): AssistantPartRenderEntry[] => {
  const entries: AssistantPartRenderEntry[] = [];
  const richPartOccurrences = new Map<string, number>();

  for (const part of parts) {
    if (!isRichChatPart(part)) {
      entries.push({ type: "standard", part });
      continue;
    }

    const identity = richPartRenderIdentity(part);
    const occurrence = (richPartOccurrences.get(identity) ?? 0) + 1;
    richPartOccurrences.set(identity, occurrence);
    entries.push({
      type: "rich",
      key: `${identity}:${occurrence}`,
      part,
    });
  }

  return entries;
};

// "Process" parts are the low-emphasis progress rows of a turn: reasoning
// trace disclosures and tool-step lines. Tool-result parts are invisible
// transport companions, so they stay inside a process run without becoming
// visible steps or splitting the run. Interactive tool cards (ask-user,
// create-document, approvals, subagent runs) read as answer content, so
// they stay outside the folded process disclosure.
const isProcessRenderEntry = (entry: AssistantPartRenderEntry): boolean => {
  if (entry.type === "rich") {
    return false;
  }
  const { part } = entry;
  if (part.type === "thinking") {
    return true;
  }
  if (part.type === "tool-result") {
    return true;
  }
  return (
    part.type === "tool-call" &&
    part.name !== "ask-user" &&
    part.name !== "create-document" &&
    part.name !== "spawn_subagents" &&
    !isApprovalPart(part)
  );
};

// Mirrors `renderEntry`'s null branches for process parts, so a run whose
// steps all render nothing (skill-lookup misses, completed searches that
// fold into the sources row) does not produce an empty disclosure.
const isVisibleProcessEntry = (entry: AssistantPartRenderEntry): boolean => {
  if (entry.type !== "standard") {
    return true;
  }
  const { part } = entry;
  if (part.type === "thinking") {
    return part.content.trim().length > 0;
  }
  if (part.type === "tool-result") {
    return false;
  }
  if (part.type !== "tool-call") {
    return true;
  }
  if (
    part.state === "error" &&
    (part.name === "load-skill" || part.name === "read-skill-resource")
  ) {
    return false;
  }
  return !(
    (part.name === "web_search" || part.name === "fetch_url") &&
    part.state === "complete"
  );
};

type ProcessStepTitleKey =
  | ReturnType<typeof getChatToolTitleKey>
  | "chat.reasoning";

const getProcessStepTitleKey = (
  entry: AssistantPartRenderEntry,
): ProcessStepTitleKey | null => {
  if (entry.type !== "standard") {
    return null;
  }
  const { part } = entry;
  if (part.type === "thinking") {
    return "chat.reasoning";
  }
  if (part.type === "tool-call") {
    return getChatToolTitleKey(part.name);
  }
  return null;
};

type AssistantPartRenderGroup =
  | {
      kind: "process";
      startIndex: number;
      entries: AssistantPartRenderEntry[];
    }
  | { kind: "standard"; index: number; entry: AssistantPartRenderEntry };

// Chunks render entries into runs of consecutive process parts so a
// multi-step turn packs its reasoning/tool rows tightly instead of
// spreading them across the message's standard part gap.
const toAssistantPartRenderGroups = (
  entries: readonly AssistantPartRenderEntry[],
): AssistantPartRenderGroup[] => {
  const groups: AssistantPartRenderGroup[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isProcessRenderEntry(entry)) {
      groups.push({ kind: "standard", index, entry });
      continue;
    }
    const previous = groups.at(-1);
    if (previous?.kind === "process") {
      previous.entries.push(entry);
      continue;
    }
    groups.push({ kind: "process", startIndex: index, entries: [entry] });
  }
  return groups;
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
  activeFileName,
  activeOrganizationId,
  assistantTextDensity,
  isGenerating,
  isLatestAssistantMessage,
  message,
  onAskUserEditAndRerun,
  onAskUserEditingChange,
  onAskUserSubmit,
  onCreateDocumentResolve,
  onOpenCreateDocumentDraft,
  onOpenCreatedDocument,
  shouldShowToolCalls,
  streamdownComponents,
  workspaceId,
}: AssistantMessagePartsProps) => {
  const restorationPairs = collectAnonRestorations(message);
  const firstThinkingPartIndex = getFirstThinkingPartIndex(message.parts);
  const reasoningTokenCount = getReasoningTokenCount(message);
  const hasAnswerContent = hasAssistantAnswerContent(message.parts);
  const renderEntries = toAssistantPartRenderEntries(message.parts);
  const renderGroups = toAssistantPartRenderGroups(renderEntries);
  const renderEntry = (entry: AssistantPartRenderEntry, index: number) => {
    if (entry.type === "rich") {
      return (
        <ChatRichMessagePart
          key={`${message.id}-${entry.key}`}
          part={entry.part}
        />
      );
    }

    const { part } = entry;
    if (part.type === "thinking") {
      return (
        <AssistantThinkingPart
          components={streamdownComponents}
          displayState={
            // Start open while this message is actively streaming its
            // reasoning (no answer text yet), but always render the same
            // disclosure so the user can collapse it immediately. Once
            // the stream settles it folds unless the user already did so.
            !hasAnswerContent && isGenerating && isLatestAssistantMessage
              ? "expanded"
              : "folded"
          }
          key={`${message.id}-thinking-${index}`}
          reasoningTokenCount={
            index === firstThinkingPartIndex ? reasoningTokenCount : null
          }
          restorationPairs={restorationPairs}
          text={part.content}
        />
      );
    }

    if (part.type === "text") {
      return (
        <AssistantTextPart
          className={cn(
            assistantTextDensity === "compact" &&
              "text-[13px] leading-5 [&_h1]:my-2 [&_h1]:text-[16px] [&_h1]:leading-5 [&_h2]:my-2 [&_h2]:text-[15px] [&_h2]:leading-5 [&_h3]:my-1.5 [&_h3]:text-[14px] [&_h3]:leading-5 [&_h4]:my-1.5 [&_h4]:text-[13px] [&_h4]:leading-5 [&_h5]:my-1.5 [&_h5]:text-[13px] [&_h5]:leading-5 [&_h6]:my-1.5 [&_h6]:text-[13px] [&_h6]:leading-5",
          )}
          components={streamdownComponents}
          key={`${message.id}-text-${index}`}
          restorationPairs={restorationPairs}
          text={part.content}
        />
      );
    }

    if (part.type === "tool-call" && isOpaquePersistedChatToolCallPart(part)) {
      return (
        <ToolCallCard
          activeOrganizationId={activeOrganizationId}
          key={part.id}
          part={part}
          showDetails={shouldShowToolCalls}
        />
      );
    }

    if (part.type === "tool-call" && part.name === "ask-user") {
      return (
        <AskUserCard
          discardsDownstream={!isLatestAssistantMessage}
          key={part.id}
          {...(onAskUserEditAndRerun && {
            onEditAndRerun: (toolCallId, output) => {
              detached(
                onAskUserEditAndRerun(toolCallId, output),
                "chat-thread-messages.ask-user-edit-and-rerun",
              );
            },
          })}
          onEditingChange={onAskUserEditingChange}
          onSubmit={(toolCallId, output) => {
            detached(
              onAskUserSubmit(toolCallId, output),
              "chat-thread-messages.ask-user-submit",
            );
          }}
          part={part}
          restorationPairs={restorationPairs}
          workspaceId={workspaceId}
        />
      );
    }

    if (part.type === "tool-call" && part.name === "create-document") {
      return (
        <NeedsMatterCard
          key={part.id}
          onOpenCreated={onOpenCreatedDocument}
          onOpenDraft={onOpenCreateDocumentDraft}
          onResolve={onCreateDocumentResolve}
          part={part}
        />
      );
    }

    if (
      part.type === "tool-call" &&
      part.state === "error" &&
      (part.name === "load-skill" || part.name === "read-skill-resource")
    ) {
      // Skill lookup is internal routing. Once the agent has the error and
      // can recover, showing the miss as a prominent transcript event adds
      // implementation noise without giving the user an action to take.
      return null;
    }

    if (
      part.type === "tool-call" &&
      (part.name === "web_search" || part.name === "fetch_url") &&
      part.state === "complete"
    ) {
      // Completed searches are rendered as a single dedup'd row by
      // <WebSearchSources> below; skipping here avoids the duplicate.
      // Other states (approval-requested, input-*) still need to fall
      // through to the approval/tool-call cards.
      return null;
    }

    if (part.type === "tool-call" && part.name === "spawn_subagents") {
      if (
        isApprovalPart(part) &&
        (part.state === "approval-requested" ||
          part.state === "approval-responded")
      ) {
        return <ToolApprovalCard key={part.id} part={part} />;
      }
      return <SpawnSubagentsCard key={part.id} part={part} />;
    }

    if (part.type === "tool-call") {
      if (isApprovalPart(part)) {
        return (
          <ToolApprovalCard
            activeFileName={activeFileName}
            key={part.id}
            part={part}
          />
        );
      }

      return (
        <ToolCallCard
          activeOrganizationId={activeOrganizationId}
          key={part.id}
          part={part}
          showDetails={shouldShowToolCalls}
        />
      );
    }

    return null;
  };
  return (
    <>
      {firstThinkingPartIndex === -1 && reasoningTokenCount !== null && (
        <AssistantReasoningTokenSummary count={reasoningTokenCount} />
      )}
      {renderGroups.map((group) => {
        if (group.kind === "standard") {
          return renderEntry(group.entry, group.index);
        }
        const visibleEntries = group.entries.filter(isVisibleProcessEntry);
        if (visibleEntries.length === 0) {
          return null;
        }
        // A run that is still receiving parts at the end of a streaming
        // message relays its current step in the collapsed summary.
        const isLiveGroup =
          isGenerating &&
          isLatestAssistantMessage &&
          group.startIndex + group.entries.length === renderEntries.length;
        const lastVisibleEntry = visibleEntries.at(-1);
        return (
          <AssistantProcessGroup
            defaultOpen={shouldShowToolCalls}
            key={`${message.id}-process-${group.startIndex}`}
            liveStepKey={
              isLiveGroup && lastVisibleEntry
                ? getProcessStepTitleKey(lastVisibleEntry)
                : null
            }
            stepCount={visibleEntries.length}
          >
            {group.entries.map((entry, offset) =>
              renderEntry(entry, group.startIndex + offset),
            )}
          </AssistantProcessGroup>
        );
      })}
      <WebSearchSources parts={message.parts} />
    </>
  );
};

type AssistantProcessGroupProps = {
  children: ReactNode;
  /** Open the step list initially on development surfaces. */
  defaultOpen: boolean;
  /** Title of the run's current step while it is still streaming. */
  liveStepKey: ProcessStepTitleKey | null;
  stepCount: number;
};

// Matches the loading-label treatment in `ToolCallCard` so the collapsed
// summary reads as the same live-status affordance.
const PROCESS_LIVE_LABEL_CLASS =
  "animate-skeleton motion-reduce:text-muted-foreground bg-[linear-gradient(90deg,var(--color-foreground-ghost)_35%,var(--color-muted-foreground)_50%,var(--color-foreground-ghost)_65%)] bg-[length:250%_100%] bg-clip-text text-transparent motion-reduce:animate-none rtl:[animation-name:skeleton-rtl]";

/**
 * One run of consecutive process steps (reasoning traces and tool rows),
 * folded into a single disclosure so the transcript reads as question and
 * answer. The collapsed summary shows the step count; while the run is
 * still streaming it relays the current step instead.
 */
const AssistantProcessGroup = ({
  children,
  defaultOpen,
  liveStepKey,
  stepCount,
}: AssistantProcessGroupProps) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <details
      className={cn(
        "max-w-[min(44rem,100%)] rounded-md",
        isOpen && "border-border/70 bg-muted/20 border",
      )}
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
      }}
      open={isOpen}
    >
      <summary
        className={cn(
          "inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5",
          "rounded-md px-2.5 py-1.5 text-xs",
          !isOpen &&
            "border-border/70 bg-background/70 hover:bg-muted/40 border shadow-sm",
          "text-muted-foreground",
          "transition-colors",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <span
          className={cn(
            "text-xs font-medium",
            liveStepKey !== null && PROCESS_LIVE_LABEL_CLASS,
          )}
        >
          {liveStepKey !== null
            ? t(liveStepKey)
            : t("common.stepCount", { count: stepCount })}
        </span>
      </summary>
      <div className="flex flex-col gap-1 px-2.5 pb-2.5">{children}</div>
    </details>
  );
};

const getFirstThinkingPartIndex = (parts: readonly ChatPart[]): number =>
  parts.findIndex(
    (part) => part.type === "thinking" && part.content.trim().length > 0,
  );

const getReasoningTokenCount = (
  message: PersistedChatMessage,
): number | null => {
  const count =
    message.metadata?.usage?.completionTokensDetails?.reasoningTokens;
  return count !== undefined && count > 0 ? count : null;
};

const hasAssistantAnswerContent = (parts: readonly ChatPart[]): boolean => {
  for (const part of parts) {
    if (part.type === "text" && part.content.trim()) {
      return true;
    }
    if (isRichChatPart(part)) {
      return true;
    }
  }
  return false;
};

const AssistantReasoningTokenSummary = ({ count }: { count: number }) => {
  const t = useTranslations();
  return (
    <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <span>{t("chat.reasoning")}</span>
      <span aria-hidden="true" className="text-foreground-placeholder">
        ·
      </span>
      <ReasoningTokenCount count={count} />
    </div>
  );
};

const ReasoningTokenCount = ({ count }: { count: number }) => {
  const t = useTranslations();
  return (
    <span className="text-muted-foreground text-[11px] leading-none tabular-nums">
      {t("chat.reasoningTokens", { count })}
    </span>
  );
};

type AssistantThinkingDisplayState = "expanded" | "folded";

const AssistantThinkingPart = ({
  components,
  displayState,
  reasoningTokenCount,
  restorationPairs,
  text,
}: {
  components: ChatThreadMessagesProps["streamdownComponents"];
  displayState: AssistantThinkingDisplayState;
  reasoningTokenCount: number | null;
  restorationPairs: readonly ChatAnonRestoration[];
  text: string;
}) => {
  const [isOpen, setIsOpen] = useState(displayState === "expanded");
  useExternalSyncEffect(() => {
    setIsOpen(displayState === "expanded");
  }, [displayState]);

  if (!text.trim()) {
    return null;
  }

  return (
    <details
      className={cn(
        "group/reasoning max-w-[min(44rem,100%)] rounded-md",
        isOpen && "border-border/70 bg-muted/20 border",
      )}
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
      }}
      open={isOpen}
    >
      <summary
        className={cn(
          "inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5",
          "rounded-md px-2.5 py-1.5 text-xs",
          !isOpen &&
            "border-border/70 bg-background/70 hover:bg-muted/40 border shadow-sm",
          "text-muted-foreground",
          "transition-colors",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <AssistantThinkingHeader
          isExpanded={isOpen}
          reasoningTokenCount={reasoningTokenCount}
        />
      </summary>
      <AssistantThinkingBody
        components={components}
        restorationPairs={restorationPairs}
        text={text}
      />
    </details>
  );
};

const AssistantThinkingHeader = ({
  isExpanded,
  reasoningTokenCount,
}: {
  isExpanded: boolean;
  reasoningTokenCount: number | null;
}) => {
  const t = useTranslations();
  return (
    <>
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 transition-transform",
          isExpanded ? "rotate-90" : "group-open/reasoning:rotate-90",
        )}
      />
      <span className="text-xs font-medium">{t("chat.reasoning")}</span>
      {reasoningTokenCount !== null && (
        <>
          <span aria-hidden="true" className="text-foreground-placeholder">
            ·
          </span>
          <ReasoningTokenCount count={reasoningTokenCount} />
        </>
      )}
    </>
  );
};

const AssistantThinkingBody = ({
  components,
  restorationPairs,
  text,
}: {
  components: ChatThreadMessagesProps["streamdownComponents"];
  restorationPairs: readonly ChatAnonRestoration[];
  text: string;
}) => (
  <div className="px-2.5 pb-2.5">
    <div className="border-s ps-2.5">
      <AssistantTextPart
        className={cn(
          "text-muted-foreground text-xs leading-relaxed",
          "[&_h1]:my-1 [&_h1]:text-xs [&_h2]:my-1 [&_h2]:text-xs",
          "[&_h3]:my-1 [&_h3]:text-xs [&_h4]:my-1 [&_h4]:text-xs",
          "[&_h5]:my-1 [&_h5]:text-xs [&_h6]:my-1 [&_h6]:text-xs",
          "[&_code]:text-[11px]",
        )}
        components={components}
        restorationPairs={restorationPairs}
        text={text}
      />
    </div>
  </div>
);

const AssistantTextPart = ({
  className,
  components,
  restorationPairs,
  text,
}: {
  className?: string | undefined;
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
  const classNamePatch =
    className === undefined ? {} : { className: cn(className) };
  if (rehypePlugins === undefined) {
    return (
      <MessageResponse
        components={components}
        fallbackChildren={assistantMessageFallbackText(text)}
        {...classNamePatch}
      >
        {text}
      </MessageResponse>
    );
  }
  return (
    <MessageResponse
      components={components}
      fallbackChildren={assistantMessageFallbackText(text)}
      rehypePlugins={rehypePlugins}
      {...classNamePatch}
    >
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
   * assistant message's metadata sidecar.
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
      <MessageResponse
        components={USER_TEXT_STREAMDOWN_COMPONENTS}
        fallbackChildren={userMessageFallbackText(text)}
      >
        {text}
      </MessageResponse>
    );
  }
  return (
    <MessageResponse
      components={USER_TEXT_STREAMDOWN_COMPONENTS}
      fallbackChildren={userMessageFallbackText(text)}
      rehypePlugins={rehypePlugins}
    >
      {text}
    </MessageResponse>
  );
};
