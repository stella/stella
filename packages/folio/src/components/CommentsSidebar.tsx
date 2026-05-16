/**
 * Comments Sidebar
 *
 * Floating cards positioned relative to their anchored text in the document.
 * Cards appear at the Y position of their corresponding text.
 * Clicking a card expands it to show reply input and action buttons.
 *
 * Tracked changes are rendered purely inline (Word-style) and do not appear
 * in this sidebar.
 */

import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  useLayoutEffect,
} from "react";

import { CheckIcon, MoreVerticalIcon } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import type { Comment, Paragraph } from "../core/types/content";
import { closestHtmlElement, queryHtmlElement } from "../core/utils/domGuards";

/** Extract plain text from a Comment's paragraph content */
function getCommentText(paragraphs?: Paragraph[]): string {
  if (!paragraphs?.length) {
    return "";
  }
  return paragraphs
    .flatMap((p) =>
      p.content
        .filter((c) => c.type === "run")
        .flatMap((r) => ("content" in r ? r.content : []))
        .filter((c) => c.type === "text")
        .map((t) => ("text" in t ? t.text : "")),
    )
    .join("");
}

function formatDate(dateStr: string | undefined, locale: string): string {
  if (!dateStr) {
    return "";
  }
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) {
    return dateStr;
  }
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(d);
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function getCommentParentId(comment: Comment): number | null | undefined {
  const runtimeComment: { parentId?: number | null } = comment;
  return runtimeComment.parentId;
}

// Kibana-style avatar colors — deterministic per author name
const AVATAR_COLORS = [
  "#6DCCB1", // teal
  "#79AAD9", // blue
  "#EE789D", // pink
  "#A987D1", // purple
  "#E6A85F", // orange
  "#F2CC8F", // gold
  "#68B3A2", // seafoam
  "#B07AA1", // mauve
  "#59A14F", // green
  "#FF9DA7", // salmon
  "#E15759", // red
  "#76B7B2", // cyan
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    // oxlint-disable-next-line eslint/no-bitwise -- intentional bitwise operation
    hash = (name.codePointAt(i) ?? 0) + ((hash << 5) - hash);
  }
  // SAFETY: modulo guarantees index is within bounds
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

export type TrackedChangeEntry = {
  type: "insertion" | "deletion";
  text: string;
  author: string;
  date?: string;
  from: number;
  to: number;
  revisionId: number;
};

export type CommentsSidebarProps = {
  comments: Comment[];
  activeCommentId?: number | null;
  onCommentClick?: (commentId: number | null) => void;
  onCommentReply?: (commentId: number, text: string) => void;
  onCommentResolve?: (commentId: number) => void;
  onCommentDelete?: (commentId: number) => void;
  onAddComment?: (text: string) => boolean | undefined;
  onCancelAddComment?: () => void;
  onAcceptChange?: (from: number, to: number) => void;
  onRejectChange?: (from: number, to: number) => void;
  onTrackedChangeReply?: (revisionId: number, text: string) => void;
  topOffset?: number;
  showResolved?: boolean;
  isAddingComment?: boolean;
  /** Y position (relative to scroll container) for the new comment input */
  addCommentYPosition?: number | null;
  /** Page width in pixels — used to position sidebar next to page edge */
  pageWidth?: number;
  /** Ref to the editor scroll container for DOM position queries */
  editorContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** Pre-computed Y positions from layout engine (keys: "comment-{id}") */
  anchorPositions?: Map<string, number>;
  /** Temporary position for a newly added comment before layout anchors update. */
};

export const SIDEBAR_WIDTH = 280;

// Minimum gap between stacked cards to avoid overlap
const MIN_CARD_GAP = 6;
const DEFAULT_CARD_HEIGHT = 64;
const DEFAULT_INPUT_HEIGHT = 104;

function arePositionMapsEqual(
  a: Map<string, number>,
  b: Map<string, number>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of b) {
    if (a.get(key) !== value) {
      return false;
    }
  }
  return true;
}

// Static styles hoisted out of component to avoid recreating on each render
const ICON_BUTTON_STYLE: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 4,
  color: "var(--doc-text-muted)",
  display: "flex",
  borderRadius: "50%",
};

const CANCEL_BUTTON_STYLE: React.CSSProperties = {
  minHeight: 28,
  padding: "5px 10px",
  fontSize: 12,
  border: "1px solid transparent",
  borderRadius: 6,
  background: "transparent",
  color: "var(--muted-foreground, var(--doc-text-muted))",
  cursor: "pointer",
  fontWeight: 500,
  fontFamily: "inherit",
};

export const CommentsSidebar: React.FC<CommentsSidebarProps> = ({
  comments,
  onCommentClick,
  activeCommentId = null,
  onCommentReply,
  onCommentResolve,
  onCommentDelete,
  onAddComment,
  onCancelAddComment,
  onAcceptChange: _onAcceptChange,
  onRejectChange: _onRejectChange,
  onTrackedChangeReply: _onTrackedChangeReply,
  topOffset = 0,
  showResolved = false,
  isAddingComment = false,
  addCommentYPosition = null,
  pageWidth = 816,
  editorContainerRef,
  anchorPositions,
}) => {
  const t = useTranslations("folio");
  const locale = useLocale();
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");
  const [newCommentText, setNewCommentText] = useState("");
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [cardPositions, setCardPositions] = useState<Map<string, number>>(
    new Map(),
  );
  const [measuredLeft, setMeasuredLeft] = useState<number | null>(null);
  const [initialPositionsDone, setInitialPositionsDone] = useState(false);
  // Track which cards have had at least one positioned render (to avoid "fall from top" animation)
  const knownCardsRef = useRef<Set<string>>(new Set());
  const lastKnownCardPositionsRef = useRef<Map<string, number>>(new Map());
  const sidebarRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const updateSidebarLeft = useCallback(() => {
    const scrollEl = editorContainerRef?.current;
    const sidebarEl = sidebarRef.current;
    const pageEl = scrollEl ? queryHtmlElement(scrollEl, ".layout-page") : null;
    const offsetParentRaw = sidebarEl?.offsetParent;
    const offsetParent =
      offsetParentRaw instanceof HTMLElement ? offsetParentRaw : null;

    if (!scrollEl || !pageEl || !offsetParent) {
      setMeasuredLeft(null);
      return;
    }

    const parentRect = offsetParent.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const rawLeft = pageRect.right - parentRect.left + 12;
    const maxVisibleLeft = Math.max(8, parentRect.width - SIDEBAR_WIDTH - 8);
    setMeasuredLeft(Math.max(8, Math.min(rawLeft, maxVisibleLeft)));
  }, [editorContainerRef]);

  useLayoutEffect(() => {
    updateSidebarLeft();
  }, [updateSidebarLeft, pageWidth, isAddingComment, comments.length]);

  useEffect(() => {
    const scrollEl = editorContainerRef?.current;
    if (!scrollEl) {
      return;
    }

    const resizeObserver = new ResizeObserver(updateSidebarLeft);
    resizeObserver.observe(scrollEl);

    const handleScroll = () => updateSidebarLeft();
    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);

    return () => {
      resizeObserver.disconnect();
      scrollEl.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, [editorContainerRef, updateSidebarLeft]);

  const visibleComments = useMemo(
    () =>
      comments.filter((c) => {
        const parentId = getCommentParentId(c);
        if (parentId !== null && parentId !== undefined) {
          return false;
        }
        if (c.done && !showResolved) {
          return false;
        }
        return true;
      }),
    [comments, showResolved],
  );

  // Pre-group replies by parentId for O(1) lookup instead of O(n) per card
  const repliesByParent = useMemo(() => {
    const map = new Map<number, Comment[]>();
    for (const c of comments) {
      const parentId = getCommentParentId(c);
      if (parentId !== null && parentId !== undefined) {
        const arr = map.get(parentId);
        if (arr) {
          arr.push(c);
        } else {
          map.set(parentId, [c]);
        }
      }
    }
    return map;
  }, [comments]);

  const getReplies = (commentId: number) =>
    repliesByParent.get(commentId) ?? [];

  // Find Y positions for comment/change anchors.
  // Uses pre-computed layout positions (anchorPositions) as primary source —
  // these work even for virtualized pages that haven't rendered to DOM.
  // Falls back to DOM queries for rendered elements (e.g., when anchorPositions unavailable).
  const updateCardPositions = useCallback(() => {
    const container = editorContainerRef?.current;
    if (!container) {
      return;
    }

    const pagesEl = container.querySelector(".paged-editor__pages");
    if (!pagesEl) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    const positions: { id: string; targetY: number; height: number }[] = [];
    const pushPosition = (id: string, targetY: number, height: number) => {
      lastKnownCardPositionsRef.current.set(id, targetY);
      positions.push({ id, targetY, height });
    };

    // Find comment positions. Prefer the rendered highlight span when present,
    // because it is the same element the user sees in the document. The
    // layout-computed map is the fallback for virtualized/non-rendered pages.
    for (const comment of visibleComments) {
      const cardId = `comment-${comment.id}`;
      const el = pagesEl.querySelector(`[data-comment-id="${comment.id}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        pushPosition(
          cardId,
          rect.top - containerRect.top + scrollTop,
          cardRefs.current.get(cardId)?.offsetHeight || DEFAULT_CARD_HEIGHT,
        );
        continue;
      }

      const layoutY = anchorPositions?.get(cardId);
      if (layoutY !== undefined) {
        pushPosition(
          cardId,
          layoutY,
          cardRefs.current.get(cardId)?.offsetHeight || DEFAULT_CARD_HEIGHT,
        );
        continue;
      }

      const lastKnownY = lastKnownCardPositionsRef.current.get(cardId);
      if (lastKnownY !== undefined && activeCommentId === comment.id) {
        positions.push({
          id: cardId,
          targetY: lastKnownY,
          height:
            cardRefs.current.get(cardId)?.offsetHeight || DEFAULT_CARD_HEIGHT,
        });
        continue;
      }

      const newCommentY =
        lastKnownCardPositionsRef.current.get("new-comment-input");
      if (activeCommentId === comment.id && newCommentY !== undefined) {
        pushPosition(
          cardId,
          newCommentY,
          cardRefs.current.get(cardId)?.offsetHeight || DEFAULT_CARD_HEIGHT,
        );
        continue;
      }
    }

    // Include the "add comment" input box in the layout if it has a Y position
    if (isAddingComment && addCommentYPosition !== null) {
      positions.push({
        id: "new-comment-input",
        targetY: addCommentYPosition,
        height:
          cardRefs.current.get("new-comment-input")?.offsetHeight ||
          DEFAULT_INPUT_HEIGHT,
      });
      lastKnownCardPositionsRef.current.set(
        "new-comment-input",
        addCommentYPosition,
      );
    }

    // Sort by target Y and resolve overlaps
    positions.sort((a, b) => a.targetY - b.targetY);
    const resolvedPositions = new Map<string, number>();
    let lastBottom = 0;

    for (const pos of positions) {
      const y = Math.max(pos.targetY, lastBottom + MIN_CARD_GAP);
      resolvedPositions.set(pos.id, y);
      lastBottom = y + pos.height;
    }

    setCardPositions((prev) =>
      arePositionMapsEqual(prev, resolvedPositions) ? prev : resolvedPositions,
    );

    const visiblePositionIds = new Set(resolvedPositions.keys());
    for (const key of lastKnownCardPositionsRef.current.keys()) {
      if (!visiblePositionIds.has(key) && key !== "new-comment-input") {
        lastKnownCardPositionsRef.current.delete(key);
      }
    }
  }, [
    visibleComments,
    editorContainerRef,
    isAddingComment,
    addCommentYPosition,
    anchorPositions,
    activeCommentId,
  ]);

  // Listen for clicks on comment/change elements in the document body → expand the sidebar card
  useEffect(() => {
    const container = editorContainerRef?.current;
    if (!container) {
      return;
    }

    const pagesEl = container.querySelector(".paged-editor__pages");
    if (!pagesEl) {
      return;
    }

    const handleDocClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) {
        return;
      }

      // Clicks inside the sidebar itself are handled by card onClick — ignore here
      if (sidebarRef.current?.contains(target)) {
        return;
      }

      // Clicks inside the pages area — check for comment highlights
      if (pagesEl.contains(target)) {
        const commentEl = closestHtmlElement(target, "[data-comment-id]");
        if (commentEl?.dataset["commentId"]) {
          setExpandedCard(`comment-${commentEl.dataset["commentId"]}`);
          onCommentClick?.(Number(commentEl.dataset["commentId"]));
          return;
        }
      }

      // Click on grey area or anywhere else outside sidebar/highlights → collapse
      setExpandedCard(null);
      setMenuOpenFor(null);
    };

    container.addEventListener("click", handleDocClick);
    return () => container.removeEventListener("click", handleDocClick);
  }, [editorContainerRef, onCommentClick]);

  // Update positions on mount, resize, and when comments/changes list changes.
  // We do NOT use a MutationObserver — it caused feedback loops because the sidebar
  // cards (which have data-comment-id) live inside the same scroll container.
  useEffect(() => {
    const container = editorContainerRef?.current;
    if (!container) {
      return;
    }

    // Calculate positions after a short delay to let the layout-painter render.
    // Run twice: once quickly for existing elements, once delayed for new marks.
    const timerQuick = setTimeout(updateCardPositions, 50);
    const timerFull = setTimeout(() => {
      updateCardPositions();
      setInitialPositionsDone(true);
    }, 400);

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(updateCardPositions);
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(timerQuick);
      clearTimeout(timerFull);
      resizeObserver.disconnect();
    };
  }, [updateCardPositions, editorContainerRef]);

  // Keep sidebar cards aligned while scrolling. This matters when page
  // virtualization swaps rendered anchors, and the map equality guard above
  // keeps the common precomputed-anchor path from rerendering on every tick.
  useEffect(() => {
    const container = editorContainerRef?.current;
    if (!container) {
      return;
    }

    let rafId: number | null = null;
    const scheduleUpdate = () => {
      if (rafId !== null) {
        return;
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateCardPositions();
      });
    };

    container.addEventListener("scroll", scheduleUpdate, { passive: true });
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      container.removeEventListener("scroll", scheduleUpdate);
    };
  }, [editorContainerRef, updateCardPositions]);

  // Recalculate positions after a card expand/collapse or add-comment toggle.
  useEffect(() => {
    const raf = requestAnimationFrame(updateCardPositions);
    return () => cancelAnimationFrame(raf);
  }, [expandedCard, isAddingComment, updateCardPositions]);

  // Watch the expanded card for size changes (reply textarea appearing, text wrapping, etc.)
  // and the add-comment input for the same. Fires when their actual rendered size changes.
  useEffect(() => {
    const targets: HTMLElement[] = [];
    if (expandedCard) {
      const el = cardRefs.current.get(expandedCard);
      if (el) {
        targets.push(el);
      }
    }
    const addEl = cardRefs.current.get("new-comment-input");
    if (addEl) {
      targets.push(addEl);
    }
    if (targets.length === 0) {
      return;
    }

    let rafId: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateCardPositions);
    });
    for (const el of targets) {
      observer.observe(el);
    }
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [expandedCard, updateCardPositions]);

  const handleNewCommentSubmit = () => {
    if (newCommentText.trim()) {
      const submitted = onAddComment?.(newCommentText.trim());
      if (submitted !== false) {
        setNewCommentText("");
      }
    }
  };

  useEffect(() => {
    if (activeCommentId === null) {
      return;
    }
    setExpandedCard(`comment-${activeCommentId}`);
  }, [activeCommentId]);

  const handleCardClick = (cardId: string, commentId?: number) => {
    const nextExpandedCard = expandedCard === cardId ? null : cardId;
    setExpandedCard(nextExpandedCard);
    setMenuOpenFor(null);
    if (commentId !== undefined) {
      onCommentClick?.(
        nextExpandedCard === null && activeCommentId === commentId
          ? null
          : commentId,
      );
    }
  };

  // Determine if we have valid positions (fallback to stacked layout if not)
  const hasPositions = cardPositions.size > 0;

  // --- Shared styles ---
  const avatarStyle = (
    name: string,
    size: 28 | 22 = 28,
  ): React.CSSProperties => ({
    width: size,
    height: size,
    borderRadius: "50%",
    backgroundColor: getAvatarColor(name),
    color: "var(--doc-canvas-text)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: size === 28 ? 12 : 10,
    fontWeight: 500,
    flexShrink: 0,
  });

  const submitButtonStyle = (enabled: boolean): React.CSSProperties => ({
    minHeight: 28,
    padding: "5px 12px",
    fontSize: 12,
    border: enabled
      ? "1px solid var(--primary, var(--doc-primary))"
      : "1px solid var(--border, var(--doc-border))",
    borderRadius: 6,
    background: enabled
      ? "var(--primary, var(--doc-primary))"
      : "var(--muted, var(--doc-bg))",
    color: enabled
      ? "var(--primary-foreground, var(--doc-page))"
      : "var(--muted-foreground, var(--doc-text-muted))",
    cursor: enabled ? "pointer" : "default",
    fontWeight: 500,
    fontFamily: "inherit",
  });

  const cardContainerStyle = (
    cardId: string,
    isExpanded: boolean,
    yPos: number | undefined,
  ): React.CSSProperties => {
    const isKnown = knownCardsRef.current.has(cardId);
    // Mark card as known once it has a valid position
    if (yPos !== undefined) {
      knownCardsRef.current.add(cardId);
    }
    // New cards (first render with position): fade in, no top transition
    // Known cards: transition top smoothly
    // Cards without position yet: hidden completely (no transition)
    const isNewCard = !isKnown && yPos !== undefined;
    const noPosition = hasPositions && yPos === undefined;
    const positionStyle = (() => {
      if (!hasPositions) {
        return { marginBottom: 6 };
      }
      if (yPos !== undefined) {
        return {
          position: "absolute" as const,
          top: yPos,
          left: 0,
          right: 0,
          opacity: 1,
        };
      }
      return {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        opacity: 0,
        visibility: "hidden" as const,
      };
    })();
    let transition = "none";
    if (!noPosition && isNewCard) {
      transition = "opacity 0.2s ease, box-shadow 0.2s ease";
    } else if (!noPosition && initialPositionsDone) {
      transition = "opacity 0.2s ease, box-shadow 0.2s ease, top 0.15s ease";
    }
    return {
      ...positionStyle,
      padding: isExpanded ? "8px 10px" : "7px 9px",
      borderRadius: 6,
      backgroundColor: "var(--doc-page)",
      cursor: "pointer",
      boxShadow: isExpanded
        ? "0 1px 2px rgba(60,64,67,0.22), 0 3px 8px rgba(60,64,67,0.12)"
        : "0 1px 2px rgba(60,64,67,0.16), 0 2px 5px rgba(60,64,67,0.08)",
      transition,
    };
  };

  // Shared reply thread renderer (used by comment cards)
  const renderReplies = (replies: Comment[], isExpanded: boolean) => {
    if (replies.length === 0) {
      return null;
    }
    return (
      <div style={{ marginTop: 8 }}>
        {(isExpanded ? replies : replies.slice(-1)).map((reply) => (
          <div
            key={reply.id}
            style={{
              marginBottom: isExpanded ? 6 : 0,
              paddingTop: 6,
              borderTop: "1px solid var(--doc-border)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <div style={avatarStyle(reply.author || "U", 22)}>
                {getInitials(reply.author || "U")}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--doc-text)",
                  }}
                >
                  {reply.author || "Unknown"}
                </div>
                <div style={{ fontSize: 10, color: "var(--doc-text-muted)" }}>
                  {formatDate(reply.date, locale)}
                </div>
              </div>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--doc-text)",
                lineHeight: "17px",
                marginTop: 4,
                ...(!isExpanded
                  ? {
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical" as const,
                    }
                  : {}),
              }}
            >
              {getCommentText(reply.content)}
            </div>
          </div>
        ))}
        {!isExpanded && replies.length > 1 && (
          <div
            style={{
              fontSize: 11,
              color: "var(--doc-text-muted)",
              marginTop: 4,
            }}
          >
            {t("comments.moreReplies", {
              count: String(replies.length - 1),
            })}
          </div>
        )}
      </div>
    );
  };

  // Reply input renderer (used by comment cards)
  const renderReplySection = (
    replyKey: number,
    submitFn?: (id: number, text: string) => void,
  ) => (
    <div
      onClick={(e) => e.stopPropagation()}
      role="presentation"
      onKeyDown={(e) => e.stopPropagation()}
      style={{ marginTop: 8 }}
    >
      {replyingTo === replyKey ? (
        <div>
          <input
            ref={(el) => el?.focus({ preventScroll: true })}
            type="text"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                if (replyText.trim() && submitFn) {
                  submitFn(replyKey, replyText.trim());
                }
                setReplyText("");
                setReplyingTo(null);
              }
              if (e.key === "Escape") {
                setReplyingTo(null);
                setReplyText("");
              }
            }}
            placeholder={t("comments.replyPlaceholder")}
            style={{
              width: "100%",
              border: "1px solid var(--doc-primary)",
              borderRadius: 6,
              outline: "none",
              fontSize: 12,
              padding: "7px 10px",
              boxSizing: "border-box",
              color: "var(--doc-text)",
              backgroundColor: "var(--doc-page)",
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 8,
            }}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setReplyingTo(null);
                setReplyText("");
              }}
              style={CANCEL_BUTTON_STYLE}
            >
              {t("comments.cancel")}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (replyText.trim() && submitFn) {
                  submitFn(replyKey, replyText.trim());
                }
                setReplyText("");
                setReplyingTo(null);
              }}
              disabled={!replyText.trim()}
              style={submitButtonStyle(!!replyText.trim())}
            >
              {t("comments.reply")}
            </button>
          </div>
        </div>
      ) : (
        <input
          readOnly
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setReplyingTo(replyKey);
          }}
          placeholder={t("comments.replyPlaceholder")}
          style={{
            width: "100%",
            border: "1px solid var(--doc-border)",
            borderRadius: 6,
            outline: "none",
            fontSize: 12,
            padding: "7px 10px",
            color: "var(--doc-text-subtle)",
            cursor: "text",
            backgroundColor: "var(--doc-page)",
            boxSizing: "border-box",
          }}
        />
      )}
    </div>
  );

  const renderCommentCard = (comment: Comment) => {
    const replies = getReplies(comment.id);
    const cardId = `comment-${comment.id}`;
    const isExpanded = expandedCard === cardId;
    const isActive = activeCommentId === comment.id;
    const yPos =
      cardPositions.get(cardId) ??
      lastKnownCardPositionsRef.current.get(cardId);

    return (
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
      <div
        key={comment.id}
        ref={(el) => {
          if (el) {
            cardRefs.current.set(cardId, el);
          } else {
            cardRefs.current.delete(cardId);
          }
        }}
        data-comment-id={comment.id}
        className="docx-comment-card"
        onClick={() => handleCardClick(cardId, comment.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            handleCardClick(cardId, comment.id);
          }
        }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          ...cardContainerStyle(cardId, isExpanded, yPos),
          opacity: comment.done ? 0.6 : 1,
          outline: isActive
            ? "2px solid var(--doc-primary, var(--primary))"
            : "none",
          outlineOffset: 2,
        }}
      >
        {/* Header: avatar + name/date + actions */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={avatarStyle(comment.author || "U")}>
            {getInitials(comment.author || "U")}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--doc-text)",
              }}
            >
              {comment.author || "Unknown"}
            </div>
            <div style={{ fontSize: 10, color: "var(--doc-text-muted)" }}>
              {formatDate(comment.date, locale)}
            </div>
          </div>
          {isExpanded && (
            <div
              style={{
                display: "flex",
                gap: 2,
                marginTop: 1,
                position: "relative",
              }}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCommentResolve?.(comment.id);
                }}
                title="Resolve"
                style={ICON_BUTTON_STYLE}
              >
                <CheckIcon size={16} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpenFor(menuOpenFor === cardId ? null : cardId);
                }}
                title="More options"
                style={ICON_BUTTON_STYLE}
              >
                <MoreVerticalIcon size={16} />
              </button>
              {menuOpenFor === cardId && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  role="menu"
                  style={{
                    position: "absolute",
                    top: 28,
                    right: 0,
                    background: "var(--doc-page)",
                    borderRadius: 6,
                    boxShadow:
                      "0 2px 6px var(--doc-shadow-md, rgba(60,64,67,0.3)), 0 1px 2px var(--doc-shadow-sm, rgba(60,64,67,0.15))",
                    zIndex: 100,
                    minWidth: 120,
                    padding: "4px 0",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpenFor(null);
                      onCommentDelete?.(comment.id);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "7px 12px",
                      border: "none",
                      background: "none",
                      textAlign: "left",
                      fontSize: 12,
                      color: "var(--doc-text)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                    onMouseOver={(e) => {
                      e.currentTarget.style.backgroundColor =
                        "var(--doc-primary-light)";
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.backgroundColor =
                        "var(--doc-primary-light)";
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Comment body */}
        <div
          style={{
            fontSize: 12,
            color: "var(--doc-text)",
            lineHeight: "17px",
            marginTop: 5,
          }}
        >
          {getCommentText(comment.content)}
        </div>

        {renderReplies(replies, isExpanded)}

        {/* Reply input */}
        {isExpanded &&
          !comment.done &&
          renderReplySection(comment.id, onCommentReply)}
      </div>
    );
  };

  return (
    <aside
      ref={sidebarRef}
      className="docx-comments-sidebar"
      role="complementary"
      aria-label="Comments"
      style={{
        position: "absolute",
        top: topOffset,
        left: measuredLeft ?? `calc(50% - 120px + ${pageWidth / 2 + 12}px)`,
        bottom: 0,
        width: SIDEBAR_WIDTH,
        fontFamily: "inherit",
        zIndex: 40,
        backgroundColor: "transparent",
        overflowY: "visible",
        overflowX: "visible",
        opacity: initialPositionsDone || cardPositions.size > 0 ? 1 : 0,
        pointerEvents:
          initialPositionsDone || cardPositions.size > 0 ? "auto" : "none",
        transition: "opacity 0.15s ease",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Cards container — relative for absolute card positioning */}
      <div style={{ position: "relative" }}>
        {/* New comment input — positioned like other cards via cardPositions */}
        {isAddingComment && (
          <div
            ref={(el) => {
              if (el) {
                cardRefs.current.set("new-comment-input", el);
              } else {
                cardRefs.current.delete("new-comment-input");
              }
            }}
            style={{
              ...(() => {
                const yPos = cardPositions.get("new-comment-input");
                if (!hasPositions) {
                  return { marginBottom: 8 };
                }
                if (yPos !== undefined) {
                  return {
                    position: "absolute" as const,
                    top: yPos,
                    left: 0,
                    right: 0,
                  };
                }
                return {
                  position: "relative" as const,
                  marginBottom: 8,
                };
              })(),
              padding: 10,
              borderRadius: 6,
              border: "1px solid var(--border, var(--doc-border))",
              backgroundColor: "var(--popover, var(--doc-page))",
              color: "var(--popover-foreground, var(--doc-text))",
              boxShadow: "0 12px 36px var(--doc-shadow-md, rgba(0,0,0,0.28))",
              zIndex: 50,
            }}
          >
            <textarea
              ref={(el) => el?.focus({ preventScroll: true })}
              value={newCommentText}
              onChange={(e) => setNewCommentText(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleNewCommentSubmit();
                }
                if (e.key === "Escape") {
                  onCancelAddComment?.();
                  setNewCommentText("");
                }
              }}
              placeholder={t("comments.addPlaceholder")}
              style={{
                width: "100%",
                border: "1px solid var(--input, var(--doc-border-input))",
                borderRadius: 6,
                outline: "none",
                resize: "none",
                fontSize: 13,
                lineHeight: "18px",
                padding: "8px 9px",
                fontFamily: "inherit",
                minHeight: 64,
                boxSizing: "border-box",
                color: "var(--foreground, var(--doc-text))",
                background: "var(--background, var(--doc-page))",
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 8,
              }}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancelAddComment?.();
                  setNewCommentText("");
                }}
                style={CANCEL_BUTTON_STYLE}
              >
                {t("comments.cancel")}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleNewCommentSubmit();
                }}
                disabled={!newCommentText.trim()}
                style={submitButtonStyle(!!newCommentText.trim())}
              >
                {t("comment")}
              </button>
            </div>
          </div>
        )}

        {/* Comments */}
        {visibleComments.map((comment) => renderCommentCard(comment))}

        {/* Empty state */}
        {visibleComments.length === 0 && !isAddingComment && (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: "var(--doc-text-subtle)",
              fontSize: 13,
            }}
          >
            {t("comments.noComments")}
          </div>
        )}
      </div>
    </aside>
  );
};
