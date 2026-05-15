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

/**
 * Walk arbitrary Folio content subtrees and collect every comment id that
 * is *referenced* by an inline anchor (`commentRangeStart`,
 * `commentRangeEnd`, or `commentReference`). Used at save time to detect
 * which comment threads still have something to anchor to, so that
 * comments whose underlying text has been edited away can be pruned
 * before serialization instead of being written out as phantom threads
 * that no Word reader can scroll to.
 *
 * Pass every part of the document that can carry anchors — comments can
 * live in headers, footers, footnotes, and endnotes as well as the
 * main body, and a save path that only checks the body would prune
 * legitimate header/footer/note comments.
 *
 * Uses `for (const key in obj)` instead of `Object.values(obj)` so the
 * recursive walk doesn't allocate a values array at every node; also
 * handles `Map` containers (e.g., `package.headers`) which `Object.values`
 * would silently skip.
 */
export function collectCommentIdsFromSources(
  ...sources: readonly unknown[]
): Set<number> {
  const ids = new Set<number>();
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (node instanceof Map) {
      for (const value of node.values()) {
        visit(value);
      }
      return;
    }
    if (typeof node !== "object") {
      return;
    }
    const obj = node as Record<string, unknown>;
    const type = obj["type"];
    if (
      (type === "commentRangeStart" ||
        type === "commentRangeEnd" ||
        type === "commentReference") &&
      typeof obj["id"] === "number"
    ) {
      ids.add(obj["id"]);
    }
    // oxlint-disable-next-line guard-for-in -- plain object literals from parser; allocating a values array here is hot-path work we want to avoid
    for (const key in obj) {
      visit(obj[key]);
    }
  };
  for (const source of sources) {
    visit(source);
  }
  return ids;
}

/**
 * Filter `comments` to drop entries whose reply chain has lost its root.
 *
 * Kept:
 *  - every top-level comment (`parentId` is null/undefined), regardless of
 *    whether its id appears in `referencedIds`,
 *  - replies whose parent chain transitively reaches a kept top-level
 *    comment.
 *
 * Dropped:
 *  - replies whose explicit `parentId` does not reach a kept top-level
 *    comment (a true broken-thread orphan).
 *
 * Why we don't prune unanchored top-level comments: pre-Word-2013
 * documents (and any document missing `commentsExtended.xml`) carry no
 * reply-thread metadata, so Word replies in those files arrive with
 * `parentId === undefined` and look indistinguishable from a true
 * top-level comment whose anchor has been edited away. Dropping
 * unanchored top-level entries would silently lose every reply in
 * those older files on the first save — a strictly worse failure mode
 * than re-emitting a comment whose anchor was actually deleted. The
 * complementary "overwrite stale `comments.xml`" fix in the save paths
 * already prevents the phantom-thread regression when the array does
 * end up empty.
 */
export function pruneOrphanedComments(
  comments: Comment[],
  _referencedIds: Set<number>,
): Comment[] {
  void _referencedIds;
  const keptIds = new Set<number>();
  // Step 1: keep every top-level comment.
  for (const comment of comments) {
    const parentId = getCommentParentId(comment);
    if (parentId === null || parentId === undefined) {
      keptIds.add(comment.id);
    }
  }
  // Step 2: iteratively pull in replies whose parent chain reaches a kept
  // top-level comment. Repeats until no new comment is added, so a
  // thread of depth N (replies-to-replies-to-…) is fully promoted in
  // N − 1 passes.
  let addedThisPass = true;
  while (addedThisPass) {
    addedThisPass = false;
    for (const comment of comments) {
      if (keptIds.has(comment.id)) {
        continue;
      }
      const parentId = getCommentParentId(comment);
      if (
        parentId !== null &&
        parentId !== undefined &&
        keptIds.has(parentId)
      ) {
        keptIds.add(comment.id);
        addedThisPass = true;
      }
    }
  }
  return comments.filter((comment) => keptIds.has(comment.id));
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
