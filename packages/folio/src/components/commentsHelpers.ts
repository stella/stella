import { Selection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { findBodyPmAnchors } from "../core/layout-bridge/findBodyPmSpans";
import type { Comment } from "../core/types/content";
import type { CommentMarkRange } from "./commentAnchors";
import { clampCommentMarkRange } from "./commentAnchors";

/** Pseudo-id for the comment mark applied while the add-comment form is open. */
export const PENDING_COMMENT_ID = -1;

/** Stable empty anchor positions Map used as the initial state. */
export const EMPTY_ANCHOR_POSITIONS = new Map<string, number>();

// In-process counter for new comment ids. Initial value is the current
// timestamp so two unrelated editor mounts in the same browser session don't
// collide on small monotonically-allocated ids.
let nextCommentId = Date.now();

export function allocateCommentId(): number {
  return nextCommentId++;
}

export function getCommentAuthorKey(author?: string): string {
  const trimmed = author?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Unknown";
}

/**
 * Y position (relative to `scrollContainer`) of the element containing the
 * given PM position. Used by the floating comment button and the context-menu
 * comment action. Queries all elements with `data-pm-start` (spans, divs,
 * imgs) — not just spans, since table cell content may use div fragments.
 */
export function findSelectionYPosition(
  scrollContainer: HTMLElement | null,
  parentEl: HTMLElement | null,
  pmPos: number,
): number | null {
  if (!scrollContainer || !parentEl) {
    return null;
  }
  const pagesEl = scrollContainer.querySelector(".paged-editor__pages");
  if (!pagesEl) {
    return null;
  }
  for (const el of findBodyPmAnchors(pagesEl)) {
    const pmStart = Number(el.dataset["pmStart"]);
    const pmEnd = Number(el.dataset["pmEnd"]);
    if (pmPos >= pmStart && pmPos <= pmEnd) {
      return (
        el.getBoundingClientRect().top -
        scrollContainer.getBoundingClientRect().top +
        scrollContainer.scrollTop
      );
    }
  }
  return null;
}

const FALLBACK_TOP_OFFSET = 80;

export function getFallbackCommentYPosition(
  scrollContainer: HTMLElement | null,
): number {
  if (!scrollContainer) {
    return FALLBACK_TOP_OFFSET;
  }
  return (
    scrollContainer.scrollTop +
    Math.max(FALLBACK_TOP_OFFSET, scrollContainer.clientHeight / 3)
  );
}

export function createComment(
  text: string,
  authorName: string,
  parentId?: number,
): Comment {
  return {
    id: allocateCommentId(),
    author: authorName,
    date: new Date().toISOString(),
    content: [
      {
        type: "paragraph",
        formatting: {},
        content: [
          { type: "run", formatting: {}, content: [{ type: "text", text }] },
        ],
      },
    ],
    ...(parentId !== undefined && { parentId }),
  };
}

export function getCommentParentId(
  comment: Comment,
): number | null | undefined {
  const runtimeComment: { parentId?: number | null } = comment;
  return runtimeComment.parentId;
}

export function applyCommentMarkRange(
  view: EditorView,
  range: CommentMarkRange,
  commentId: number,
  options?: { replacePending?: boolean; selectEnd?: boolean },
): boolean {
  const commentMark = view.state.schema.marks["comment"];
  const safeRange = clampCommentMarkRange(view.state.doc.content.size, range);
  if (!commentMark || !safeRange) {
    return false;
  }

  let tr = view.state.tr;
  if (options?.replacePending) {
    // Target only the pending placeholder mark. Passing the MarkType would
    // remove every comment mark in the range, including any pre-existing
    // (non-pending) comments the new selection happens to overlap.
    tr = tr.removeMark(
      safeRange.from,
      safeRange.to,
      commentMark.create({ commentId: PENDING_COMMENT_ID }),
    );
  }
  tr = tr.addMark(
    safeRange.from,
    safeRange.to,
    commentMark.create({ commentId }),
  );

  if (options?.selectEnd) {
    tr = tr.setSelection(Selection.near(tr.doc.resolve(safeRange.to), -1));
  }

  view.dispatch(tr);
  return true;
}

export function removePendingCommentMarkRange(
  view: EditorView,
  range: CommentMarkRange,
): void {
  const commentMark = view.state.schema.marks["comment"];
  const safeRange = clampCommentMarkRange(view.state.doc.content.size, range);
  if (!commentMark || !safeRange) {
    return;
  }

  view.dispatch(
    view.state.tr.removeMark(
      safeRange.from,
      safeRange.to,
      commentMark.create({ commentId: PENDING_COMMENT_ID }),
    ),
  );
}
