import {
  CASE_LAW_ANNOTATION_COLORS,
  CASE_LAW_ANNOTATION_STYLES,
} from "@stll/api-contract/case-law-annotations";
import type {
  CaseLawAnnotationColor,
  CaseLawAnnotationStyle,
  CaseLawAnnotationVisibility,
} from "@stll/api-contract/case-law-annotations";

import type { SelectionAnchor } from "@/features/case-law/annotations/selection-anchor";

export type AnnotationColor = CaseLawAnnotationColor;
export type AnnotationStyle = CaseLawAnnotationStyle;
export type AnnotationVisibility = CaseLawAnnotationVisibility;

export const ANNOTATION_COLORS = CASE_LAW_ANNOTATION_COLORS;

export const ANNOTATION_STYLES = CASE_LAW_ANNOTATION_STYLES;

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
