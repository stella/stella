import type { ReactElement, ReactNode } from "react";

import type {
  ReaderAnnotationColor as AnnotationColor,
  ReaderAnnotationStyle as AnnotationStyle,
} from "@stll/api-contract/legal-reader-annotations";
import type { Block } from "@stll/legal-ast/document-ast";
import { TextMark } from "@stll/ui/text-mark";
import type {
  TextMarkOptions,
  TextMarkTone,
  TextMarkVariant,
} from "@stll/ui/text-mark";

import type { TextAnchor } from "./document-ast-text";

/** A reader's highlight or comment, as a span to draw over the text. */
export type AnnotationAnchorSource = {
  blockAnchorId: string;
  color: AnnotationColor | null;
  endOffset: number;
  id: string;
  kind: "highlight" | "comment";
  startOffset: number;
  /** How a highlight is drawn; null for a comment. */
  style: AnnotationStyle | null;
};

const STYLE_VARIANT = {
  highlight: "fill",
  underline: "underline",
  squiggly: "wavy",
  strikethrough: "strike",
} as const satisfies Record<AnnotationStyle, TextMarkVariant>;

const COLOR_TONE = {
  yellow: "option-yellow",
  green: "option-green",
  sky: "option-sky",
  violet: "option-violet",
  red: "option-red",
} as const satisfies Record<AnnotationColor, TextMarkTone>;

/**
 * A mark on the text, drawn the way PDF readers draw mark-up: a colour and a
 * style. A comment is a dotted underline in the margin colour; the words
 * stay readable under every style, including a strike, since the reader's
 * own mark must never hide the law's text.
 */
const annotationMark = ({
  color,
  kind,
  style,
}: AnnotationAnchorSource): TextMarkOptions =>
  kind === "comment"
    ? { variant: "dotted", tone: "option-sky" }
    : {
        variant: STYLE_VARIANT[style ?? "highlight"],
        tone: COLOR_TONE[color ?? "yellow"],
      };

const renderAnnotation = (
  annotation: AnnotationAnchorSource,
  children: ReactNode,
): ReactElement => (
  <TextMark
    {...annotationMark(annotation)}
    className="cursor-pointer"
    data-annotation-id={annotation.id}
  >
    {children}
  </TextMark>
);

/** One run of text and the single mark that draws it. */
export type AnnotationSegment = {
  annotation: AnnotationAnchorSource;
  end: number;
  start: number;
};

/**
 * Which of the marks covering a run draws it: the innermost one, and among
 * equals the lower id. A reader who highlights a phrase inside a paragraph
 * they had already marked means the phrase, so the narrower mark is the one
 * they see and the one a click on those words activates. The id breaks the
 * remaining tie so the same marks always produce the same reading.
 */
/** Ids are keys, not words: any total order does, as long as it is the same
 * one everywhere. */
const compareIds = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const drawsRun = (
  left: AnnotationAnchorSource,
  right: AnnotationAnchorSource,
): number =>
  right.startOffset - left.startOffset ||
  left.endOffset - right.endOffset ||
  compareIds(left.id, right.id);

/**
 * The marks of one piece as runs that do not overlap. The renderer walks
 * anchors with a single cursor and re-emits whatever a later anchor covers
 * behind it, so two marks over the same words would print those words twice;
 * splitting at every boundary is what keeps the text on screen exactly the
 * text the document holds. Runs that the same mark draws end to end are
 * merged again, so a mark nothing overlaps stays one element.
 */
export const annotationSegments = (
  annotations: readonly AnnotationAnchorSource[],
): AnnotationSegment[] => {
  const spans = annotations.filter(
    (annotation) => annotation.endOffset > annotation.startOffset,
  );
  const boundaries = [
    ...new Set(
      spans.flatMap((annotation) => [
        annotation.startOffset,
        annotation.endOffset,
      ]),
    ),
  ].toSorted((left, right) => left - right);

  const segments: AnnotationSegment[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start === undefined || end === undefined) {
      continue;
    }
    const covering = spans.filter(
      (annotation) =>
        annotation.startOffset <= start && annotation.endOffset >= end,
    );
    const annotation = covering.toSorted(drawsRun).at(0);
    if (annotation === undefined) {
      // A gap between two marks that do not touch.
      continue;
    }
    const previous = segments.at(-1);
    if (previous?.annotation === annotation && previous.end === start) {
      previous.end = end;
      continue;
    }
    segments.push({ annotation, end, start });
  }
  return segments;
};

/** The anchors for one piece's marks, offset into the piece's own text. */
export const annotationTextAnchors = (
  annotations: readonly AnnotationAnchorSource[],
  offset = 0,
): TextAnchor[] =>
  annotationSegments(annotations).map(({ annotation, end, start }) => ({
    end: offset + end,
    key: `annotation:${annotation.id}:${String(start)}`,
    render: (children): ReactElement => renderAnnotation(annotation, children),
    start: offset + start,
  }));

/**
 * Every mark by the piece it is drawn in. A mark is stored against the
 * element the reader selected in, which is a block's stable anchor in a
 * parsed document and the piece's own id everywhere else (a table cell, a
 * fulltext paragraph); `blocks` translates the first kind, and an anchor
 * that is already a piece id passes through. A mark whose piece the document
 * no longer has is dropped rather than drawn somewhere else.
 */
export const buildAnnotationAnchors = (
  annotations: readonly AnnotationAnchorSource[],
  blocks: readonly Block[] = [],
): Record<string, TextAnchor[]> => {
  const pieceIdByBlockAnchorId = new Map(
    blocks.map((block) => [block.anchorId, block.id] as const),
  );
  const byPiece = new Map<string, AnnotationAnchorSource[]>();
  for (const annotation of annotations) {
    const pieceId =
      pieceIdByBlockAnchorId.get(annotation.blockAnchorId) ??
      annotation.blockAnchorId;
    const existing = byPiece.get(pieceId);
    if (existing === undefined) {
      byPiece.set(pieceId, [annotation]);
      continue;
    }
    existing.push(annotation);
  }

  const anchorsByPieceId: Record<string, TextAnchor[]> = {};
  for (const [pieceId, pieceAnnotations] of byPiece) {
    anchorsByPieceId[pieceId] = annotationTextAnchors(pieceAnnotations);
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
