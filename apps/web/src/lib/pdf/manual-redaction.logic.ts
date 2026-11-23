import { panic } from "better-result";

import type { PDFSearchBox } from "@/lib/pdf/pdf-search";
import type { PageViewport } from "@/lib/pdf/pdfjs-loader";

/**
 * A rectangle over a displayed PDF page, as fractions of the page box with the
 * origin at the top left. Fractions keep a drawn area stable across zoom.
 */
export type ManualRedactionRegion = {
  readonly pageIndex: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

/** A drawn area, with the displayed page size (PDF points) it was drawn on. */
export type ManualRedactionArea = ManualRedactionRegion & {
  readonly id: string;
  readonly pageWidth: number;
  readonly pageHeight: number;
};

/** The areas drawn on one PDF, named by `pdfDocumentKey`. */
export type ManualRedactionExport = {
  readonly documentKey: string;
  readonly areas: readonly ManualRedactionArea[];
};

export type ManualRedactionPageRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

// A page-relative threshold remains stable when the reader zoom changes.
const MIN_NORMALIZED_EDGE = 0.002;
// Displayed page sizes come from the same PDF.js viewport math on both sides.
const PAGE_SIZE_TOLERANCE_PT = 0.01;

/** The PDF.js fingerprints of a document, as one comparable key. */
export const pdfDocumentKey = (
  fingerprints: readonly (string | null)[],
): string => fingerprints.map((fingerprint) => fingerprint ?? "").join("/");

export const isManualRedactionPageRectUnchanged = (
  initial: ManualRedactionPageRect,
  current: ManualRedactionPageRect,
): boolean =>
  initial.left === current.left &&
  initial.top === current.top &&
  initial.width === current.width &&
  initial.height === current.height;

type ManualRedactionDrag = {
  pageIndex: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
  pageRect: ManualRedactionPageRect;
};

export const manualRedactionFromDrag = ({
  pageIndex,
  start,
  end,
  pageRect,
}: ManualRedactionDrag): ManualRedactionRegion | null => {
  if (
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 0 ||
    ![
      start.x,
      start.y,
      end.x,
      end.y,
      pageRect.left,
      pageRect.top,
      pageRect.width,
      pageRect.height,
    ].every(Number.isFinite) ||
    pageRect.width <= 0 ||
    pageRect.height <= 0
  ) {
    return null;
  }
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const left = clamp(
    (Math.min(start.x, end.x) - pageRect.left) / pageRect.width,
  );
  const right = clamp(
    (Math.max(start.x, end.x) - pageRect.left) / pageRect.width,
  );
  const top = clamp(
    (Math.min(start.y, end.y) - pageRect.top) / pageRect.height,
  );
  const bottom = clamp(
    (Math.max(start.y, end.y) - pageRect.top) / pageRect.height,
  );
  if (
    right - left < MIN_NORMALIZED_EDGE ||
    bottom - top < MIN_NORMALIZED_EDGE
  ) {
    return null;
  }
  return { pageIndex, left, top, right, bottom };
};

const isValidRegion = (region: ManualRedactionRegion) =>
  Number.isSafeInteger(region.pageIndex) &&
  region.pageIndex >= 0 &&
  [region.left, region.top, region.right, region.bottom].every(
    Number.isFinite,
  ) &&
  region.left >= 0 &&
  region.top >= 0 &&
  region.right <= 1 &&
  region.bottom <= 1 &&
  region.right > region.left &&
  region.bottom > region.top;

export const isValidManualRedactionArea = (area: ManualRedactionArea) =>
  area.id.length > 0 &&
  isValidRegion(area) &&
  Number.isFinite(area.pageWidth) &&
  Number.isFinite(area.pageHeight) &&
  area.pageWidth > 0 &&
  area.pageHeight > 0;

export type ManualRedactionAreasAction =
  | { type: "add"; area: ManualRedactionArea }
  | { type: "remove"; id: string }
  | { type: "clear" };

export const reduceManualRedactionAreas = (
  areas: readonly ManualRedactionArea[],
  action: ManualRedactionAreasAction,
): readonly ManualRedactionArea[] => {
  switch (action.type) {
    case "add": {
      if (
        !isValidManualRedactionArea(action.area) ||
        areas.some(({ id }) => id === action.area.id)
      ) {
        panic("A manual redaction area must be valid and have a unique id");
      }
      return [...areas, { ...action.area }];
    }
    case "remove": {
      const remaining = areas.filter(({ id }) => id !== action.id);
      return remaining.length === areas.length ? areas : remaining;
    }
    case "clear":
      return areas.length === 0 ? areas : [];
    default:
      action satisfies never;
      return panic("Unhandled manual redaction action");
  }
};

/** True when `page` (displayed size, PDF points) is the page the area was drawn on. */
export const manualRedactionPageMatches = (
  area: ManualRedactionArea,
  page: { width: number; height: number },
) =>
  Math.abs(area.pageWidth - page.width) <= PAGE_SIZE_TOLERANCE_PT &&
  Math.abs(area.pageHeight - page.height) <= PAGE_SIZE_TOLERANCE_PT;

const parsePoint = (value: unknown) => {
  if (!Array.isArray(value)) {
    return null;
  }
  const x: unknown = value.at(0);
  const y: unknown = value.at(1);
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }
  return { x, y };
};

/**
 * The area as a box in the page's PDF user space, through the viewport the
 * page is rendered with, so rotation and the page box origin map the same way
 * as for a detected term's mask.
 */
export const manualRedactionAreaToPdfBox = (
  area: ManualRedactionRegion,
  viewport: Pick<PageViewport, "width" | "height" | "convertToPdfPoint">,
): PDFSearchBox | null => {
  if (!isValidRegion(area)) {
    return null;
  }
  const start = parsePoint(
    viewport.convertToPdfPoint(
      area.left * viewport.width,
      area.top * viewport.height,
    ),
  );
  const end = parsePoint(
    viewport.convertToPdfPoint(
      area.right * viewport.width,
      area.bottom * viewport.height,
    ),
  );
  if (!start || !end) {
    return null;
  }
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
};
