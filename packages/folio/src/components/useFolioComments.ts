/**
 * Comment subsystem state for {@link DocxEditor}: thread storage, author
 * visibility filtering, the in-progress "add comment" flow, and the DOM
 * highlight sync. Extracted to keep the comment surface in one named seam
 * rather than scattered across the editor component. Save-coupled mutators
 * (`replaceComments`/`updateComments`) stay in the component because they
 * depend on its document-build pipeline.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Comment } from "../core/types/content";
import type { Document } from "../core/types/document";
import {
  PENDING_COMMENT_ID,
  getCommentAuthorKey,
  getCommentParentId,
} from "./commentsHelpers";

type UseFolioCommentsOptions = {
  /** Current document (history head); seeds comments on first load. */
  doc: Document | null;
  autoOpenReviewSidebar: boolean;
  /** Anchor offsets from layout; re-triggers highlight sync when they shift. */
  anchorPositions: Map<string, number>;
  /** Editor content root used to locate comment-marked run nodes. */
  editorContentRef: { readonly current: HTMLElement | null };
};

export function useFolioComments({
  doc,
  autoOpenReviewSidebar,
  anchorPositions,
  editorContentRef,
}: UseFolioCommentsOptions) {
  const [showCommentsSidebar, setShowCommentsSidebar] = useState(false);
  const [visibleCommentAuthors, setVisibleCommentAuthors] =
    useState<Set<string> | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<number | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const commentsDirtyRef = useRef(false);
  const commentsRef = useRef<Comment[]>([]);
  commentsRef.current = comments;

  const [isAddingComment, setIsAddingComment] = useState(false);
  const [commentSelectionRange, setCommentSelectionRange] = useState<{
    from: number;
    to: number;
  } | null>(null);
  const [addCommentYPosition, setAddCommentYPosition] = useState<number | null>(
    null,
  );

  // Floating "add comment" button position (relative to scroll container, null = hidden)
  const [floatingCommentBtn, setFloatingCommentBtn] = useState<{
    top: number;
    left: number;
    from: number;
    to: number;
  } | null>(null);

  // Extract comments from document model on initial load
  const commentsLoadedRef = useRef(false);
  useEffect(() => {
    if (commentsLoadedRef.current) {
      return;
    }
    if (!doc) {
      return;
    }
    const bodyComments = doc.package.document.comments;
    if (bodyComments && bodyComments.length > 0) {
      setComments(bodyComments);
      setVisibleCommentAuthors(null);
      setActiveCommentId(null);
      if (autoOpenReviewSidebar) {
        setShowCommentsSidebar(true);
      }
      commentsLoadedRef.current = true;
    }
  }, [autoOpenReviewSidebar, doc]);

  const commentAuthors = useMemo(() => {
    const seen = new Set<string>();
    const authors: string[] = [];
    for (const comment of comments) {
      const commentAuthor = getCommentAuthorKey(comment.author);
      if (!seen.has(commentAuthor)) {
        seen.add(commentAuthor);
        authors.push(commentAuthor);
      }
    }
    return authors;
  }, [comments]);

  const visibleCommentAuthorSet = useMemo(
    () => visibleCommentAuthors ?? new Set(commentAuthors),
    [visibleCommentAuthors, commentAuthors],
  );

  const visibleCommentIds = useMemo(() => {
    const ids = new Set<number>([PENDING_COMMENT_ID]);
    for (const comment of comments) {
      if (visibleCommentAuthorSet.has(getCommentAuthorKey(comment.author))) {
        ids.add(comment.id);
      }
    }
    return ids;
  }, [comments, visibleCommentAuthorSet]);

  const visibleComments = useMemo(() => {
    const visibleRootIds = new Set<number>();
    for (const comment of comments) {
      const parentId = getCommentParentId(comment);
      if (
        parentId === null ||
        parentId === undefined ||
        !visibleCommentIds.has(comment.id)
      ) {
        continue;
      }
      visibleRootIds.add(parentId);
    }
    return comments.filter((comment) => {
      const parentId = getCommentParentId(comment);
      if (parentId !== null && parentId !== undefined) {
        return visibleCommentIds.has(comment.id);
      }
      return (
        visibleCommentIds.has(comment.id) || visibleRootIds.has(comment.id)
      );
    });
  }, [comments, visibleCommentIds]);

  const activeCommentVisible =
    activeCommentId !== null && visibleCommentIds.has(activeCommentId);

  useEffect(() => {
    if (!activeCommentVisible) {
      setActiveCommentId(null);
    }
  }, [activeCommentVisible]);

  const syncCommentHighlightStyles = useCallback(() => {
    const root = editorContentRef.current;
    if (!root) {
      return;
    }

    const nodes = root.querySelectorAll<HTMLElement>(
      ".layout-run-text[data-comment-id]",
    );
    for (const node of nodes) {
      const commentId = Number.parseInt(node.dataset["commentId"] ?? "", 10);
      const isPending = commentId === PENDING_COMMENT_ID;
      const isVisible = isPending || visibleCommentIds.has(commentId);
      if (!isVisible) {
        node.style.backgroundColor = "transparent";
        node.style.borderBottom = "2px solid transparent";
        node.style.boxShadow = "none";
        delete node.dataset["activeComment"];
        continue;
      }

      if (activeCommentId === commentId) {
        node.style.backgroundColor =
          "var(--doc-comment-active-bg, rgba(255, 212, 0, 0.22))";
        node.style.borderBottom =
          "1px solid var(--doc-comment-active-border, rgba(180, 130, 0, 0.62))";
        node.style.boxShadow = "none";
        node.dataset["activeComment"] = "true";
        continue;
      }

      node.style.backgroundColor =
        "var(--doc-comment-bg, rgba(255, 212, 0, 0.08))";
      node.style.borderBottom =
        "1px solid var(--doc-comment-border, rgba(180, 130, 0, 0.24))";
      node.style.boxShadow = "none";
      delete node.dataset["activeComment"];
    }
  }, [visibleCommentIds, activeCommentId, editorContentRef]);

  useLayoutEffect(() => {
    syncCommentHighlightStyles();
  }, [syncCommentHighlightStyles, anchorPositions]);

  useEffect(() => {
    syncCommentHighlightStyles();
    const firstFrame = requestAnimationFrame(() => {
      syncCommentHighlightStyles();
      requestAnimationFrame(syncCommentHighlightStyles);
    });
    const timeout = setTimeout(syncCommentHighlightStyles, 120);
    return () => {
      cancelAnimationFrame(firstFrame);
      clearTimeout(timeout);
    };
  }, [comments.length, syncCommentHighlightStyles]);

  return {
    comments,
    setComments,
    commentsRef,
    commentsDirtyRef,
    commentsLoadedRef,
    showCommentsSidebar,
    setShowCommentsSidebar,
    setVisibleCommentAuthors,
    activeCommentId,
    setActiveCommentId,
    isAddingComment,
    setIsAddingComment,
    commentSelectionRange,
    setCommentSelectionRange,
    addCommentYPosition,
    setAddCommentYPosition,
    floatingCommentBtn,
    setFloatingCommentBtn,
    commentAuthors,
    visibleCommentAuthorSet,
    visibleComments,
    syncCommentHighlightStyles,
  };
}
