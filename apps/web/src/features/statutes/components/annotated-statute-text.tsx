import type { ComponentProps, RefObject } from "react";

import type { AnnotationAnchorSource } from "@/components/legal-reader/annotations/annotation-anchors";
import { AnnotationToolbar } from "@/components/legal-reader/annotations/annotation-toolbar";
import { GuestAnnotationPrompt } from "@/components/legal-reader/annotations/guest-annotation-prompt";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import { useActiveReaderAnnotation } from "@/components/legal-reader/annotations/use-active-reader-annotation";
import { useReaderAnnotations } from "@/components/legal-reader/annotations/use-reader-annotations";
import { StatuteText } from "@/features/statutes/components/statute-text";
import { provisionByBlockAnchor } from "@/features/statutes/statute-reader-blocks";

type AnnotatedStatuteTextProps = Omit<
  ComponentProps<typeof StatuteText>,
  "annotationAnchors"
> & {
  country: string;
  eli: string;
  scrollContainerRef: RefObject<HTMLElement | null>;
};

/**
 * The statute's text with the reader's own marks on it, and the mark-up bar
 * that puts them there. The same bar, store and API the decision reader uses:
 * only the document it names differs.
 *
 * The consolidation's own id is the target, so a mark always belongs to the
 * exact wording it was placed on and a later amendment cannot move it.
 */
export const AnnotatedStatuteText = ({
  country,
  eli,
  scrollContainerRef,
  ...statuteText
}: AnnotatedStatuteTextProps) => {
  const target = {
    type: "statute",
    country,
    eli,
    id: statuteText.documentId,
    provisionByAnchorId: provisionByBlockAnchor(statuteText.blocks),
    title: statuteText.statuteTitle,
    versionValidFrom: statuteText.versionValidFrom,
  } as const satisfies ReaderAnnotationTarget;
  const annotations = useReaderAnnotations(target);
  const { activeAnnotation, activeSpans, clearActive, setActiveAnnotationId } =
    useActiveReaderAnnotation({
      annotations: annotations.annotations,
      scrollContainerRef,
    });
  const annotationAnchors: AnnotationAnchorSource[] =
    annotations.annotations.map((item) => ({
      blockAnchorId: item.blockAnchorId,
      color: item.color,
      endOffset: item.endOffset,
      id: item.id,
      kind: item.kind,
      startOffset: item.startOffset,
      style: item.style,
    }));

  return (
    <>
      {/* Sticky rather than above the scroll container: the statutes reader
          scrolls the whole column, so a banner outside it would sit under the
          shell's own chrome. */}
      <GuestAnnotationPrompt
        className="sticky top-0 z-20"
        count={annotations.guestCount}
      />
      <StatuteText {...statuteText} annotationAnchors={annotationAnchors} />
      <AnnotationToolbar
        activeAnnotation={activeAnnotation}
        activeSpans={activeSpans}
        controller={annotations.controller}
        mode={annotations.mode}
        onActivateAnnotation={setActiveAnnotationId}
        onClearActive={clearActive}
        scrollContainerRef={scrollContainerRef}
        target={target}
      />
    </>
  );
};
