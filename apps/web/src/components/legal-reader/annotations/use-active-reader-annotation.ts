import { useState } from "react";
import type { RefObject } from "react";

import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import { isPendingAnnotationId } from "@/components/legal-reader/annotations/use-reader-annotations";
import { useExternalSyncEffect } from "@/hooks/use-effect";

type ActiveReaderAnnotation = {
  activeAnnotation: ReaderAnnotation | null;
  /** Every row of the active mark: one per paragraph it covers. */
  activeSpans: readonly ReaderAnnotation[];
  clearActive: () => void;
  setActiveAnnotationId: (id: string | null) => void;
};

const rowsOfMark = (
  annotations: readonly ReaderAnnotation[],
  mark: ReaderAnnotation | null,
): readonly ReaderAnnotation[] => {
  if (mark === null) {
    return [];
  }
  return mark.groupId === null
    ? [mark]
    : annotations.filter((row) => row.groupId === mark.groupId);
};

/**
 * The mark the reader clicked, and the words it covers put back under the
 * selection so the toolbar reads as acting on them — exactly as if the reader
 * had dragged over them. Shared by both readers so a mark behaves the same in
 * a decision and in a statute.
 */
export const useActiveReaderAnnotation = ({
  annotations,
  scrollContainerRef,
}: {
  annotations: readonly ReaderAnnotation[];
  scrollContainerRef: RefObject<HTMLElement | null>;
}): ActiveReaderAnnotation => {
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null,
  );
  // A mark the server has not stored yet has no id to act on, so it is not
  // active even if clicked.
  const activeAnnotation =
    annotations.find(
      (item) =>
        item.id === activeAnnotationId && !isPendingAnnotationId(item.id),
    ) ?? null;
  // A mark over several paragraphs is several rows under one group; the bar
  // acts on all of them, and a comment left from the mark covers them all.
  const activeSpans = rowsOfMark(annotations, activeAnnotation);
  // Runs from the id in state, so the toolbar's once-installed document
  // listener never holds a stale list.
  const activeRowIds = activeSpans.map((row) => row.id).join(" ");
  useExternalSyncEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || activeRowIds === "") {
      return;
    }
    const pieces: HTMLElement[] = [];
    for (const id of activeRowIds.split(" ")) {
      pieces.push(
        ...container.querySelectorAll<HTMLElement>(
          `[data-annotation-id="${CSS.escape(id)}"]`,
        ),
      );
    }
    const first = pieces.at(0);
    const last = pieces.at(-1);
    if (first === undefined || last === undefined) {
      return;
    }
    const range = container.ownerDocument.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const selection = container.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [activeRowIds, scrollContainerRef]);

  return {
    activeAnnotation,
    activeSpans,
    clearActive: () => setActiveAnnotationId(null),
    setActiveAnnotationId,
  };
};
