import {
  READER_ANNOTATION_COLORS,
  READER_ANNOTATION_STYLES,
} from "@stll/api-contract/legal-reader-annotations";
import type {
  ReaderAnnotationColor,
  ReaderAnnotationStyle,
  ReaderAnnotationVisibility,
} from "@stll/api-contract/legal-reader-annotations";

import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";

export type AnnotationColor = ReaderAnnotationColor;
export type AnnotationStyle = ReaderAnnotationStyle;
export type AnnotationVisibility = ReaderAnnotationVisibility;

export const ANNOTATION_COLORS = READER_ANNOTATION_COLORS;

export const ANNOTATION_STYLES = READER_ANNOTATION_STYLES;

export type CreateAnnotationInput = { spans: SelectionAnchor[] } & (
  | {
      kind: "highlight";
      color: AnnotationColor;
      style: AnnotationStyle;
      visibility: AnnotationVisibility;
    }
  | { kind: "comment"; body: string; visibility: AnnotationVisibility }
);

/** One named change to one annotation. */
export type UpdateAnnotationInput = { id: string } & (
  | { change: "body"; body: string }
  | { change: "color"; color: AnnotationColor }
  | { change: "style"; style: AnnotationStyle }
  | { change: "visibility"; visibility: AnnotationVisibility }
);
