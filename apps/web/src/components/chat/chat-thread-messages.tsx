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
import { ChatImageAttachment } from "@/components/chat/chat-image-attachment";
import type {
  AskUserOutput,
  ChatAnonRestoration,
  ChatAttachmentPart,
  ChatPart,
  ChatUITools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { isApprovalPart } from "@/components/chat/chat-ui-tools";
import { NeedsMatterCard } from "@/components/chat/needs-matter-card";
import { rehypeAnonSpans } from "@/components/chat/rehype-anon-spans";
import { SourceChips } from "@/components/chat/source-chips";
import { SpawnSubagentsCard } from "@/components/chat/spawn-subagents-card";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { ToolApprovalCard } from "@/components/chat/tool-approval-card";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { WebSearchSources } from "@/components/chat/web-search-sources";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useMaybeStickToBottomContext } from "@/hooks/use-stick-to-bottom";
import type { TranslationKey } from "@/i18n/types";
import { dedupeById } from "@/lib/dedupe-by-id";
import {
  getUserFileContentUrl,
  getUserFileThumbnailUrl,
} from "@/lib/user-files";
import type { QueuedChatMessage } from "@/routes/_protected.chat/-hooks/use-chat-session";

export const ChatThreadMessages = ({
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
  onOpenCreatedDocument,
  showThinkingIndicator = false,
  showToolCallDetails,
  showToolCalls,
  stickyUserMessages = false,
  queuedMessages,
  onRemoveQueuedMessage,
  streamdownComponents,
  workspaceId,
}: ChatThreadMessagesProps) => {
  const { activeOrganizationId } = useChatApproval();
  // The transcript can briefly hold both the optimistic streamed copy and the
  // persisted copy of one message during the per-turn refetch handoff; both
  // carry the same id, so React would render it twice. Collapse by id before
  // any downstream read. Memoized because this component bails out of React
  // Compiler (see below), so the manual memos here need a stable `messages`.
  const messages = useMemo(() => dedupeById(rawMessages), [rawMessages]);
  // This component bails out of React Compiler (a suppression below), so its
  // manual memoization is kept (RC will not auto-memoize a bailed component).
  const retryableAssistantMessageId = useMemo(
    () => getRetryableAssistantMessageId(messages),
    [messages],
  );
  const shouldShowToolCalls = showToolCallDetails ?? showToolCalls ?? false;

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

  const triggerLoadOlder = () => {
    const container = scrollRef?.current;
    if (container) {
      anchorScrollHeightRef.current = container.scrollHeight;
    }
    void onLoadOlder?.();
  };

  // Drive the trigger from a top sentinel: when it scrolls into view
  // (with a buffer) and an older page exists, fetch it. The observer
  // re-arms each render so it tracks the latest `canLoadOlder` /
  // `isLoadingOlder` without firing while a fetch is in flight.
  useExternalSyncEffect(() => {
    const root = scrollRef?.current;
    const target = sentinelRef.current;
    if (!root || !target || !canLoadOlder || isLoadingOlder || loadOlderError) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- triggerLoadOlder/scrollRef are stable refs; onLoadOlder tracks the active thread
  }, [canLoadOlder, isLoadingOlder, loadOlderError, onLoadOlder]);

  // Scroll anchoring: a prepend changes the first message id and grows
  // scrollHeight above the viewport. Restore the previous offset before
  // paint so the message under the user's eye stays put. Bottom-appends
  // and streaming keep the first id, so they skip this and stick-to-
  // bottom handles them; a thread switch changes the id too but has no
  // captured anchor, so it is also skipped.
  // eslint-disable-next-line react/react-compiler -- scroll-anchoring layout effect mutates the DOM node's scrollTop through the forwarded scrollRef prop; DOM mutation in a layout effect is the correct pattern here
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
    // eslint-disable-next-line react/react-compiler -- adjusts the scroll container's scrollTop (DOM node reached via the forwarded scrollRef prop) to anchor position after a prepend; a legitimate layout-effect DOM mutation
    container.scrollTop += container.scrollHeight - previousScrollHeight;
  }, [firstMessageId, scrollRef]);

  // Rendered per message in both the flat and sticky layouts, so the message
  // body markup stays identical across surfaces; only the surrounding turn
  // grouping differs when `stickyUserMessages` is on.
  const renderMessageNode = (message: PersistedChatMessage, index: number) => (
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
              isGenerating={isGenerating}
              isLatestAssistantMessage={
                message.id === retryableAssistantMessageId
              }
              message={message}
              onAskUserEditAndRerun={onAskUserEditAndRerun}
              onAskUserEditingChange={onAskUserEditingChange}
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
              sourceDocuments={message.metadata?.sourceDocuments}
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
              return (
                <Fragment key={`orphan-${turnIndex}`}>
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

type TurnBodyItem = {
  message: PersistedChatMessage;
  /** Position in the flat `messages` list, kept so anon-restoration lookups
   *  and retry targeting stay identical to the non-sticky layout. */
  index: number;
};

/**
 * A transcript segment. `user` turns start with a user message that becomes
 * the sticky header; `orphan` turns hold assistant/system messages that
 * precede any user message (e.g. a greeting, or the tail of an older turn
 * pulled in by pagination) and render without a sticky header.
 */
type MessageTurn =
  | {
      type: "user";
      index: number;
      header: PersistedChatMessage;
      body: TurnBodyItem[];
    }
  | { type: "orphan"; body: TurnBodyItem[] };

/**
 * Groups the flat message list into turns for the sticky layout: every user
 * message opens a new turn and the following non-user messages attach to it,
 * so each turn's height spans its whole answer. That height is what gives the
 * sticky header room to pin — a header can only stick within its own turn, so
 * the next turn's header pushes it out as it reaches the top.
 */
export const buildMessageTurns = (
  messages: readonly PersistedChatMessage[],
): MessageTurn[] => {
  const turns: MessageTurn[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      turns.push({ type: "user", index, header: message, body: [] });
      continue;
    }
    const last = turns.at(-1);
    if (last) {
      last.body.push({ message, index });
      continue;
    }
    turns.push({ type: "orphan", body: [{ message, index }] });
  }
  return turns;
};

type StickyUserTurnProps = {
  approvalPendingMessageId: string | null;
  headerIndex: number;
  headerMessage: PersistedChatMessage;
  messages: readonly PersistedChatMessage[];
  scrollRef: RefObject<HTMLDivElement | null> | null;
  children: ReactNode;
};

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
    <section className="relative flex flex-col gap-3">
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
          // Unstuck: opaque band flush with the page (no chrome/box).
          "data-[stuck=false]:bg-background",
          // Stuck: near-opaque glass veil + blur matching the floating
          // composer and sidebar, so the pinned message floats over the
          // answer scrolling beneath. The veil is raised toward opaque
          // (/95, /80 with backdrop-filter) so the moving answer text
          // barely ghosts through instead of competing with the header.
          "data-[stuck=true]:bg-background/95 supports-[backdrop-filter]:data-[stuck=true]:bg-background/80 data-[stuck=true]:backdrop-blur-md",
          // The veil band stays pinned flush to the pane top (top-0) so it
          // always covers the answer scrolling through beneath it; the top
          // padding then insets the bubble by a sliver, so the pinned
          // message floats with a little blurred breathing room above it
          // rather than leaning against the pane's top edge. A rounded
          // bottom + fine border reads as a floating shelf, not a hard cut.
          "data-[stuck=true]:border-border/50 data-[stuck=true]:rounded-b-xl data-[stuck=true]:border-b data-[stuck=true]:pt-1",
        )}
        data-stuck={isStuck ? "true" : "false"}
      >
        {/* Behind the bubble: while stuck the bubble goes pointer-events-none
            so plain text falls through to this jump target, and only its
            interactive children (anonymization pills) re-enable clicks. */}
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

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const collectAnonRestorations = (
  message: PersistedChatMessage,
): readonly ChatAnonRestoration[] => {
  // De-dupe placeholder→original pairs across multiple parts in a
  // single assistant message so the rehype plugin builds one
  // pattern per stream.
  const seen = new Map<string, string>();
  for (const pair of message.metadata?.anonRestorations?.pairs ?? []) {
    if (!seen.has(pair.placeholder)) {
      seen.set(pair.placeholder, pair.original);
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
 * message (skipping any intervening user messages — TanStack
 * messages persist in chronological order) and uses its
 * server-emitted metadata pairs, which were produced by
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
      return collectAnonRestorations(candidate);
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
        if (IMAGE_MEDIA_TYPES.has(mimeType)) {
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
            <span>{filename ?? fallbackLabel}</span>
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
  provider_billing: "chat.sendErrorProviderBilling",
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
      if (part.type === "text" && part.content.trim()) {
        return true;
      }

      if (part.type === "tool-call") {
        return true;
      }

      if (part.type === "thinking" && part.content.trim()) {
        return true;
      }
    }
  }

  return false;
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
  /** Whether an older page exists to load above the current top. */
  hasOlderMessages?: boolean | undefined;
  isGenerating?: boolean | undefined;
  /** True while an older page is being fetched + prepended. */
  isLoadingOlder?: boolean | undefined;
  /** True after an older-page fetch failed; pauses the auto-trigger so the
   *  sentinel cannot loop the request (the manual button still retries). */
  loadOlderError?: boolean | undefined;
  messages: PersistedChatMessage[];
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
  | "onAskUserEditAndRerun"
  | "onAskUserEditingChange"
  | "onAskUserSubmit"
  | "onCreateDocumentResolve"
  | "onOpenCreatedDocument"
  | "streamdownComponents"
  | "workspaceId"
> & {
  activeOrganizationId: string;
  isGenerating: boolean;
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
  isGenerating,
  isLatestAssistantMessage,
  message,
  onAskUserEditAndRerun,
  onAskUserEditingChange,
  onAskUserSubmit,
  onCreateDocumentResolve,
  onOpenCreatedDocument,
  shouldShowToolCalls,
  streamdownComponents,
  workspaceId,
}: AssistantMessagePartsProps) => {
  const restorationPairs = collectAnonRestorations(message);
  const firstThinkingPartIndex = getFirstThinkingPartIndex(message.parts);
  const reasoningTokenCount = getReasoningTokenCount(message);
  const hasAnswerText = hasAssistantAnswerText(message.parts);
  return (
    <>
      {firstThinkingPartIndex === -1 && reasoningTokenCount !== null && (
        <AssistantReasoningTokenSummary count={reasoningTokenCount} />
      )}
      {message.parts.map((part, index) => {
        if (part.type === "thinking") {
          return (
            <AssistantThinkingPart
              components={streamdownComponents}
              displayState={
                hasAnswerText
                  ? { status: "folded" }
                  : {
                      isStreaming: isGenerating && isLatestAssistantMessage,
                      status: "expanded",
                    }
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
              components={streamdownComponents}
              key={`${message.id}-text-${index}`}
              restorationPairs={restorationPairs}
              text={part.content}
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
                  void onAskUserEditAndRerun(toolCallId, output);
                },
              })}
              onEditingChange={onAskUserEditingChange}
              onSubmit={(toolCallId, output) => {
                void onAskUserSubmit(toolCallId, output);
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
              onResolve={onCreateDocumentResolve}
              part={part}
            />
          );
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
            return (
              <ToolApprovalCard
                key={part.id}
                part={part}
                workspaceId={workspaceId}
              />
            );
          }
          return <SpawnSubagentsCard key={part.id} part={part} />;
        }

        if (part.type === "tool-call") {
          if (isApprovalPart(part)) {
            return (
              <ToolApprovalCard
                key={part.id}
                part={part}
                workspaceId={workspaceId}
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
      })}
      <WebSearchSources parts={message.parts} />
    </>
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

const hasAssistantAnswerText = (parts: readonly ChatPart[]): boolean => {
  for (const part of parts) {
    if (part.type === "text" && part.content.trim()) {
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

type AssistantThinkingDisplayState =
  | { status: "expanded"; isStreaming: boolean }
  | { status: "folded" };

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
  if (!text.trim()) {
    return null;
  }

  if (displayState.status === "expanded") {
    return (
      <div className="border-border/70 bg-muted/20 max-w-[min(44rem,100%)] rounded-md border">
        <div className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs">
          <AssistantThinkingHeader
            isExpanded
            isStreaming={displayState.isStreaming}
            reasoningTokenCount={reasoningTokenCount}
          />
        </div>
        <AssistantThinkingBody
          components={components}
          restorationPairs={restorationPairs}
          text={text}
        />
      </div>
    );
  }

  return (
    <details className="group/reasoning w-fit max-w-full rounded-md">
      <summary
        className={cn(
          "inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5",
          "border-border/70 bg-background/70 rounded-md border px-2.5 py-1.5 text-xs shadow-sm",
          "text-muted-foreground",
          "hover:bg-muted/40 transition-colors",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <AssistantThinkingHeader
          isExpanded={false}
          isStreaming={false}
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
  isStreaming,
  reasoningTokenCount,
}: {
  isExpanded: boolean;
  isStreaming: boolean;
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
      {isStreaming && (
        <span className="bg-foreground-placeholder size-1.5 animate-pulse rounded-full" />
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
        className="text-muted-foreground text-xs leading-relaxed"
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
  const classNamePatch = className === undefined ? {} : { className };
  if (rehypePlugins === undefined) {
    return (
      <MessageResponse components={components} {...classNamePatch}>
        {text}
      </MessageResponse>
    );
  }
  return (
    <MessageResponse
      components={components}
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
