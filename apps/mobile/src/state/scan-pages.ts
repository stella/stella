import { Result } from "better-result";
import * as v from "valibot";

import type { ScannedPage } from "@/native/document-scanner";

/** A quarter turn clockwise, in degrees. */
export type Rotation = 0 | 90 | 180 | 270;

/** A scanned page as the review lists it: its image and how far it is turned. */
export type ReviewPage = ScannedPage & {
  /** Stable across reordering: the page's own file. */
  readonly key: string;
  readonly rotation: Rotation;
};

const scannedPagesSchema = v.pipe(
  v.array(
    v.object({
      uri: v.pipe(v.string(), v.startsWith("file://")),
      thumbnailUri: v.pipe(v.string(), v.startsWith("file://")),
      size: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
  v.minLength(1),
);

/** The pages a scan handed to the review, as its route parameter carries them. */
export const encodeScannedPages = (pages: readonly ScannedPage[]): string =>
  JSON.stringify(
    pages.map(({ size, thumbnailUri, uri }) => ({ size, thumbnailUri, uri })),
  );

/** Reads the route parameter back; anything but a list of pages is none. */
export const decodeScannedPages = (
  encoded: string | undefined,
): readonly ScannedPage[] => {
  const parsed = Result.try(() => JSON.parse(encoded ?? "") as unknown);
  if (Result.isError(parsed)) {
    return [];
  }
  const pages = v.safeParse(scannedPagesSchema, parsed.value);
  return pages.success ? pages.output : [];
};

/** Fresh pages, upright, ready to append to the review. */
export const reviewPages = (
  scanned: readonly ScannedPage[],
): readonly ReviewPage[] =>
  scanned.map((page) => ({ ...page, key: page.uri, rotation: 0 }));

/** The page at `from` taken out and put back at `to`, both within the list. */
export const movePage = (
  pages: readonly ReviewPage[],
  from: number,
  to: number,
): readonly ReviewPage[] => {
  const moved = pages[from];
  if (moved === undefined || to < 0 || to >= pages.length || from === to) {
    return pages;
  }
  const rest = pages.filter((_, index) => index !== from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
};

/** The page `key` turned a quarter clockwise. */
export const rotatePage = (
  pages: readonly ReviewPage[],
  key: string,
): readonly ReviewPage[] =>
  pages.map((page) =>
    page.key === key
      ? { ...page, rotation: NEXT_ROTATION[page.rotation] }
      : page,
  );

/** A quarter turn clockwise from each rotation. */
const NEXT_ROTATION: Readonly<Record<Rotation, Rotation>> = {
  0: 90,
  90: 180,
  180: 270,
  270: 0,
};

/** The pages without `key`. */
export const removePage = (
  pages: readonly ReviewPage[],
  key: string,
): readonly ReviewPage[] => pages.filter((page) => page.key !== key);

/**
 * The file name the PDF is shared and stored under: the document's name, or
 * `fallback` when it has none, ending in `.pdf`.
 */
export const pdfName = (name: string, fallback: string): string => {
  const trimmed = name.trim() === "" ? fallback.trim() : name.trim();
  return trimmed.toLocaleLowerCase().endsWith(".pdf")
    ? trimmed
    : `${trimmed}.pdf`;
};

/**
 * The bytes of every page together. The PDF takes each page's image as it
 * is, so this is its size but for a few kilobytes of structure.
 */
export const totalSize = (pages: readonly ReviewPage[]): number =>
  pages.reduce((sum, page) => sum + page.size, 0);

/** A size as the Files app writes one: kilobytes under a megabyte, then megabytes, in thousands. */
export const sizeInUnits = (
  bytes: number,
): { readonly unit: "kilobytes" | "megabytes"; readonly value: number } =>
  bytes < 1_000_000
    ? { unit: "kilobytes", value: Math.max(1, Math.round(bytes / 1000)) }
    : { unit: "megabytes", value: Math.round(bytes / 100_000) / 10 };

/**
 * Where a dragged row lands: its start moved by whole rows of the distance
 * dragged, kept within the list.
 */
export const dropIndex = ({
  count,
  dy,
  from,
  rowHeight,
}: {
  readonly count: number;
  readonly dy: number;
  readonly from: number;
  readonly rowHeight: number;
}): number =>
  Math.min(count - 1, Math.max(0, from + Math.round(dy / rowHeight)));

/**
 * How far a row that is not being dragged moves aside while one is: a row's
 * height towards the dragged row's start, when the drag crosses it.
 */
export const rowShift = ({
  drag,
  index,
  rowHeight,
}: {
  readonly drag: { readonly from: number; readonly to: number } | null;
  readonly index: number;
  readonly rowHeight: number;
}): number => {
  if (drag === null || index === drag.from) {
    return 0;
  }
  if (drag.from < drag.to && index > drag.from && index <= drag.to) {
    return -rowHeight;
  }
  if (drag.to < drag.from && index >= drag.to && index < drag.from) {
    return rowHeight;
  }
  return 0;
};
