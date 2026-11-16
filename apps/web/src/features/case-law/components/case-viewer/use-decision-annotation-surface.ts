import { useState } from "react";
import type { RefObject } from "react";

import type { AnnotationAnchorSource } from "@stll/decision-reader/annotation-anchors";
import type { ReaderTextPiece } from "@stll/legal-ast/reader-text-quote";

import { saveCommentEdit } from "@/components/legal-reader/annotations/comment-edit";
import { placeReaderAnnotations } from "@/components/legal-reader/annotations/reader-annotation-placement.logic";
import type { OrphanedReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotation-placement.logic";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";
import { useActiveReaderAnnotation } from "@/components/legal-reader/annotations/use-active-reader-annotation";
import type { ReaderAnnotationController } from "@/components/legal-reader/annotations/use-reader-annotation-history";
import { useReaderAnnotations } from "@/components/legal-reader/annotations/use-reader-annotations";
import type {
  CommentMarginItem,
  ComposerMarginItem,
} from "@/components/legal-reader/margin-notes";
import { annotationsForMarksFilter } from "@/features/case-law/components/case-viewer/decision-annotation-surface.logic";
import type { ReaderMarksFilter } from "@/features/case-law/components/case-viewer/decision-annotation-surface.logic";
import { detached } from "@/lib/detached";

type DecisionAnnotationSurfaceOptions = {
  /** Which stored marks this surface draws. */
  marks: ReaderMarksFilter;
  scrollContainerRef: RefObject<HTMLElement | null>;
  target: ReaderAnnotationTarget;
  /**
   * The decision's anchored text as the reader draws it, which places the
   * stored marks; null until the decision has loaded.
   */
  text: readonly ReaderTextPiece[] | null;
};

export type DecisionAnnotationSurface = {
  /** The mark the reader clicked, for the bar to act on. */
  activeAnnotation: ReaderAnnotation | null;
  /** Every row of the active mark: one per paragraph it covers. */
  activeSpans: readonly ReaderAnnotation[];
  /** What the text paints over its own words. */
  anchors: AnnotationAnchorSource[];
  clearActive: () => void;
  controller: ReaderAnnotationController;
  /** Marks this tab holds that no account owns yet. */
  guestCount: number;
  mode: "authenticated" | "guest";
  /** The comments on the text and the one being written, in reading order. */
  notes: (CommentMarginItem | ComposerMarginItem)[];
  /** Marks whose words the current text has in no single place. */
  orphaned: OrphanedReaderAnnotation[];
  /** Removes one of the reader's own orphaned marks. */
  removeOrphaned: (id: string) => void;
  setActiveAnnotationId: (id: string | null) => void;
  /** The reader chose to comment on these paragraphs. */
  startComposing: (spans: SelectionAnchor[]) => void;
};

/**
 * Everything a reader needs to mark a decision and to talk about it: the
 * stored marks, the mark being made, the mark clicked, and the words waiting
 * to be sent. One owner, so the full page and the inspector pane differ in
 * where they draw the result and in nothing else.
 */
export const useDecisionAnnotationSurface = ({
  marks,
  scrollContainerRef,
  target,
  text,
}: DecisionAnnotationSurfaceOptions): DecisionAnnotationSurface => {
  const annotations = useReaderAnnotations(target);
  // The comment being written: its paragraphs, so the note sits with the
  // first and the saved comment covers them all.
  const [composing, setComposing] = useState<SelectionAnchor[] | null>(null);
  // Every mark is drawn where its words are in this text, which a re-parse
  // since it was made may have moved, or listed apart when they are not.
  const { orphaned, placed: visibleRows } = placeReaderAnnotations(
    annotationsForMarksFilter(annotations.annotations, marks),
    text,
  );
  const { activeAnnotation, activeSpans, clearActive, setActiveAnnotationId } =
    useActiveReaderAnnotation({
      annotations: visibleRows,
      scrollContainerRef,
    });
  const anchors: AnnotationAnchorSource[] = visibleRows.map((item) => ({
    blockAnchorId: item.blockAnchorId,
    color: item.color,
    endOffset: item.endOffset,
    id: item.id,
    kind: item.kind,
    quote: item.quote,
    startOffset: item.startOffset,
    style: item.style,
  }));
  // A comment over several paragraphs is several rows; its words sit on the
  // first, and that is the one the note shows.
  const commentNotes: CommentMarginItem[] = visibleRows
    .filter((item) => item.kind === "comment" && item.body !== null)
    .map((item) => ({
      author: { image: item.authorImage, name: item.authorName },
      createdAt: item.createdAt,
      id: item.id,
      kind: "comment",
      mine: item.mine,
      onDelete: () => {
        detached(
          annotations.controller.remove(item.id),
          "legal-reader.annotation-remove",
        );
      },
      onEdit: (edit) => {
        detached(
          saveCommentEdit({
            comment: {
              body: item.body ?? "",
              id: item.id,
              visibility: item.visibility,
            },
            edit,
            update: annotations.controller.update,
          }),
          "legal-reader.annotation-comment-edit",
        );
      },
      onToggleVisibility: () => {
        detached(
          annotations.controller.update({
            change: "visibility",
            id: item.id,
            visibility: item.visibility === "shared" ? "private" : "shared",
          }),
          "legal-reader.annotation-visibility",
        );
      },
      startAnchorId: item.blockAnchorId,
      targetType: target.type,
      text: item.body ?? "",
      updatedAt: item.updatedAt,
      visibility: item.visibility,
    }));
  const composerNotes = ((): ComposerMarginItem[] => {
    if (composing === null) {
      return [];
    }
    const first = composing.at(0);
    if (first === undefined) {
      return [];
    }
    return [
      {
        id: "composer",
        kind: "composer",
        onCancel: () => setComposing(null),
        onSubmit: (body, visibility) => {
          detached(
            annotations.controller.create({
              body,
              kind: "comment",
              spans: composing,
              visibility,
            }),
            "legal-reader.annotation-comment",
          );
          setComposing(null);
        },
        startAnchorId: first.blockAnchorId,
        targetType: target.type,
      },
    ];
  })();

  return {
    activeAnnotation,
    activeSpans,
    anchors,
    clearActive,
    controller: annotations.controller,
    guestCount: annotations.guestCount,
    mode: annotations.mode,
    // The composer is never filtered away: the reader is mid-sentence in it.
    notes: [...commentNotes, ...composerNotes],
    orphaned,
    removeOrphaned: (id) => {
      detached(
        annotations.controller.remove(id),
        "legal-reader.annotation-remove",
      );
    },
    setActiveAnnotationId,
    startComposing: setComposing,
  };
};
