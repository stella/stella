import type { CSSProperties, ReactElement, ReactNode } from "react";

import { panic } from "better-result";

import type { Block } from "@stll/legal-ast/document-ast";
import { cn } from "@stll/ui/utils";

import type { TextAnchor } from "@/components/legal-reader/document-ast-text";

/** A reader's highlight or comment, as a span to draw over the text. */
export type AnnotationAnchorSource = {
  blockAnchorId: string;
  color: string | null;
  endOffset: number;
  id: string;
  kind: "highlight" | "comment";
  startOffset: number;
  /** How a highlight is drawn; null for a comment. */
  style: "highlight" | "underline" | "squiggly" | "strikethrough" | null;
};

/**
 * A mark on the text, drawn the way PDF readers draw mark-up: a colour and a
 * style. A comment is a dotted underline in the margin colour; the words
 * stay readable under every style, including a strike, since the reader's
 * own mark must never hide the law's text.
 */
const annotationClassName = ({
  kind,
  style,
}: AnnotationAnchorSource): string => {
  if (kind === "comment") {
    return "cursor-pointer bg-transparent text-inherit underline decoration-dotted decoration-2 underline-offset-4";
  }
  switch (style) {
    case "underline": {
      return "cursor-pointer bg-transparent text-inherit underline decoration-2 underline-offset-3";
    }
    case "squiggly": {
      return "cursor-pointer bg-transparent text-inherit underline decoration-wavy decoration-2 underline-offset-3";
    }
    case "strikethrough": {
      return "cursor-pointer bg-transparent text-inherit line-through decoration-2";
    }
    case "highlight":
    case null: {
      // No padding or rounding: a mark over several inline runs is several
      // elements, and only a flat background reads as one continuous mark.
      return "cursor-pointer text-inherit";
    }
    default: {
      style satisfies never;
      return panic(`Unhandled style: ${String(style)}`);
    }
  }
};

const annotationStyle = ({
  color,
  kind,
  style,
}: AnnotationAnchorSource): CSSProperties => {
  if (kind === "comment") {
    return { textDecorationColor: "var(--option-sky)" };
  }
  const swatch = `var(--option-${color ?? "yellow"})`;
  return style === "highlight" || style === null
    ? { backgroundColor: `color-mix(in srgb, ${swatch} 32%, transparent)` }
    : { textDecorationColor: swatch };
};

const renderAnnotation = (
  annotation: AnnotationAnchorSource,
  children: ReactNode,
): ReactElement => (
  <mark
    className={cn(annotationClassName(annotation))}
    data-annotation-id={annotation.id}
    style={annotationStyle(annotation)}
  >
    {children}
  </mark>
);

export const annotationTextAnchor = (
  annotation: AnnotationAnchorSource,
  offset = 0,
): TextAnchor => ({
  end: offset + annotation.endOffset,
  key: `annotation:${annotation.id}`,
  render: (children): ReactElement => renderAnnotation(annotation, children),
  start: offset + annotation.startOffset,
});

const pushAnchor = (
  anchorsByPieceId: Record<string, TextAnchor[]>,
  pieceId: string,
  annotation: AnnotationAnchorSource,
): void => {
  const anchors = anchorsByPieceId[pieceId];
  if (anchors === undefined) {
    anchorsByPieceId[pieceId] = [annotationTextAnchor(annotation)];
    return;
  }
  anchors.push(annotationTextAnchor(annotation));
};

/**
 * Every mark by the piece it sits in, where a piece is named by the block
 * anchor the mark was stored against. That is the fulltext fallback, whose
 * paragraphs are their own anchors.
 */
export const buildStandaloneAnnotationAnchors = (
  annotations: readonly AnnotationAnchorSource[],
): Record<string, TextAnchor[]> => {
  const anchorsByPieceId: Record<string, TextAnchor[]> = {};
  for (const annotation of annotations) {
    pushAnchor(anchorsByPieceId, annotation.blockAnchorId, annotation);
  }
  return anchorsByPieceId;
};

/**
 * Every mark by the piece it sits in, for a parsed document. A mark is stored
 * against the block's stable anchor, which is what the reader selects and
 * deep-links by, while `BlockRenderer` lays anchors by the block's render id;
 * translating between the two is what puts the mark on the right words. A
 * mark whose block the document no longer has is dropped rather than drawn
 * somewhere else.
 */
export const buildBlockAnnotationAnchors = (
  annotations: readonly AnnotationAnchorSource[],
  blocks: readonly Block[],
): Record<string, TextAnchor[]> => {
  const pieceIdByBlockAnchorId = new Map(
    blocks.map((block) => [block.anchorId, block.id] as const),
  );
  const anchorsByPieceId: Record<string, TextAnchor[]> = {};
  for (const annotation of annotations) {
    const pieceId = pieceIdByBlockAnchorId.get(annotation.blockAnchorId);
    if (pieceId !== undefined) {
      pushAnchor(anchorsByPieceId, pieceId, annotation);
    }
  }
  return anchorsByPieceId;
};

export const renderLinkAnnotations = ({
  annotations,
  children,
}: {
  annotations: readonly AnnotationAnchorSource[];
  children: ReactNode;
}): ReactNode => {
  let marked = children;
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations.at(index);
    if (annotation !== undefined) {
      marked = renderAnnotation(annotation, marked);
    }
  }
  return marked;
};
