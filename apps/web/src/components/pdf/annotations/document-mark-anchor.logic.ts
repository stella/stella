/**
 * Between a mark's anchor and the PDF page the viewer shows.
 *
 * An anchor is a page and UTF-16 offsets into that page's text as LibPDF
 * extracts it, the quoted words, and the digest of the page text it was
 * placed on. The viewer reads the same bytes with the same extractor and
 * keeps the glyph box behind every unit, so drawing a mark is a slice of
 * those boxes: in PDF units, scaled with the page, so it stays on its words
 * at every zoom without measuring the DOM.
 *
 * The other way, a selection in pdf.js's text layer becomes an anchor by
 * finding the selected words in LibPDF's page text: the two extractors agree
 * on the characters but not always on the whitespace between them, so the
 * words are matched with whitespace ignored, nearest the place on the page
 * where the selection began.
 */

import { panic } from "better-result";

import { READER_ANNOTATION_QUOTE_MAX_LENGTH } from "@stll/api-contract/legal-reader-annotations";
import type {
  ReaderAnnotationColor,
  ReaderAnnotationStyle,
} from "@stll/api-contract/legal-reader-annotations";
import type { TextMarkTone, TextMarkVariant } from "@stll/ui/text-mark";

import { mergePDFSearchBoxes } from "@/lib/pdf/pdf-search";
import type { PageSearchText, PDFSearchBox } from "@/lib/pdf/pdf-search";

type TextRange = { start: number; end: number };

export type MarkAnchor = {
  /** The file the mark was placed on. */
  fieldId: string;
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  quote: string;
  pageTextSha256: string;
};

export type MarkPageText = PageSearchText & { sha256: string };

/** Why a mark is listed beside the pages instead of drawn on one. */
export const DETACHED_REASON = {
  /** Placed on another version, whose page read differently. */
  otherVersion: "other-version",
  /** This file's page no longer reads as it did; the words are not on it. */
  textChanged: "text-changed",
} as const;
export type DetachedReason =
  (typeof DETACHED_REASON)[keyof typeof DETACHED_REASON];

export type MarkPlacement =
  /** The page's text is still being read. */
  | { type: "reading" }
  | { type: "placed"; boxes: PDFSearchBox[]; range: TextRange }
  | { type: "detached"; reason: DetachedReason };

const isWhitespace = (unit: string) => /\s/u.test(unit);

/** The page text without whitespace, and where each unit came from. */
const squeeze = (text: string) => {
  const units: string[] = [];
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charAt(index);
    if (!isWhitespace(unit)) {
      units.push(unit);
      offsets.push(index);
    }
  }
  return { text: units.join(""), offsets };
};

/**
 * Where the words occur in the page text with whitespace ignored, the
 * occurrence starting nearest `near` first; ranges into the page text, from
 * the first word's first unit to the last word's last.
 */
export const findWordsOnPage = ({
  near,
  pageText,
  words,
}: {
  near: number;
  pageText: string;
  words: string;
}): TextRange | null => {
  const needle = squeeze(words).text;
  if (needle.length === 0) {
    return null;
  }
  const page = squeeze(pageText);
  let best: TextRange | null = null;
  for (
    let found = page.text.indexOf(needle);
    found !== -1;
    found = page.text.indexOf(needle, found + 1)
  ) {
    const start =
      page.offsets.at(found) ?? panic("A squeezed unit lost its offset");
    const last =
      page.offsets.at(found + needle.length - 1) ??
      panic("A squeezed unit lost its offset");
    const candidate = { start, end: last + 1 };
    if (
      best === null ||
      Math.abs(candidate.start - near) < Math.abs(best.start - near)
    ) {
      best = candidate;
    }
  }
  return best;
};

const boxesFor = (page: PageSearchText, range: TextRange): PDFSearchBox[] =>
  mergePDFSearchBoxes(
    page.boxesByOffset
      .slice(range.start, range.end)
      .filter((box): box is PDFSearchBox => box !== null),
  );

const placed = (
  page: PageSearchText,
  range: TextRange | null,
  reason: DetachedReason,
): MarkPlacement => {
  const boxes = range === null ? [] : boxesFor(page, range);
  return range === null || boxes.length === 0
    ? { type: "detached", reason }
    : { type: "placed", boxes, range };
};

type PlaceMarkOptions = {
  anchor: MarkAnchor;
  /** The viewer's text of the anchor's page; undefined while it is read or
   *  when the file has no such page. */
  page: MarkPageText | undefined;
  /** The page texts are read, so a missing page is truly missing. */
  pagesRead: boolean;
  /** The file the viewer shows. */
  viewedFieldId: string;
};

/**
 * Where a mark sits on the file the viewer shows. A page that reads exactly
 * as it did when the mark was made (the same digest, on this file or another
 * version's) takes the stored offsets as they are. This file's page read
 * differently (a newer extractor) still shows the quoted words where they
 * are found nearest their old place. Another version's page that reads
 * differently is not this mark's text: the mark is listed as detached with
 * its quote, never drawn over other words.
 */
export const placeMark = ({
  anchor,
  page,
  pagesRead,
  viewedFieldId,
}: PlaceMarkOptions): MarkPlacement => {
  if (page === undefined) {
    return pagesRead
      ? {
          type: "detached",
          reason:
            anchor.fieldId === viewedFieldId
              ? DETACHED_REASON.textChanged
              : DETACHED_REASON.otherVersion,
        }
      : { type: "reading" };
  }
  if (
    page.sha256 === anchor.pageTextSha256 &&
    page.text.slice(anchor.startOffset, anchor.endOffset) === anchor.quote
  ) {
    return placed(
      page,
      { start: anchor.startOffset, end: anchor.endOffset },
      DETACHED_REASON.textChanged,
    );
  }
  if (anchor.fieldId !== viewedFieldId) {
    return { type: "detached", reason: DETACHED_REASON.otherVersion };
  }
  return placed(
    page,
    findWordsOnPage({
      near: anchor.startOffset,
      pageText: page.text,
      words: anchor.quote,
    }),
    DETACHED_REASON.textChanged,
  );
};

/** One text layer's share of a selection, as the DOM holds it. */
export type SelectedLayerText = {
  pageNumber: number;
  /** The selected text of this layer. */
  text: string;
  /** Units of the layer's text before the selection starts in it. */
  before: number;
  /** All units of the layer's text. */
  total: number;
};

export type LocatedSpan = {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  /** The page's own words at those offsets: what the server checks. */
  quote: string;
};

/** Why a selection could not become an anchor. */
export const SELECTION_REFUSAL = {
  /** The page has no extracted text (a scan without OCR). */
  noText: "no-text",
  /** The selected words are not in the page's text. */
  notFound: "not-found",
  /** One page's share is longer than a mark may quote. */
  tooLong: "too-long",
} as const;
export type SelectionRefusal =
  (typeof SELECTION_REFUSAL)[keyof typeof SELECTION_REFUSAL];

export type LocatedSelection =
  | { type: "located"; spans: LocatedSpan[] }
  | { type: "refused"; reason: SelectionRefusal; pageNumber: number };

/**
 * The anchor of each page's share of a selection: the selected words found
 * in the page's extracted text, nearest the proportion of the layer the
 * selection began at.
 */
export const locateSelection = ({
  layers,
  pages,
}: {
  layers: readonly SelectedLayerText[];
  pages: ReadonlyMap<number, PageSearchText>;
}): LocatedSelection => {
  const spans: LocatedSpan[] = [];
  for (const layer of layers) {
    const page = pages.get(layer.pageNumber);
    if (page === undefined || page.text.trim().length === 0) {
      return {
        type: "refused",
        reason: SELECTION_REFUSAL.noText,
        pageNumber: layer.pageNumber,
      };
    }
    const near =
      layer.total === 0
        ? 0
        : Math.round((layer.before / layer.total) * page.text.length);
    const range = findWordsOnPage({
      near,
      pageText: page.text,
      words: layer.text,
    });
    if (range === null) {
      return {
        type: "refused",
        reason: SELECTION_REFUSAL.notFound,
        pageNumber: layer.pageNumber,
      };
    }
    const quote = page.text.slice(range.start, range.end);
    if (quote.length > READER_ANNOTATION_QUOTE_MAX_LENGTH) {
      return {
        type: "refused",
        reason: SELECTION_REFUSAL.tooLong,
        pageNumber: layer.pageNumber,
      };
    }
    spans.push({
      pageNumber: layer.pageNumber,
      startOffset: range.start,
      endOffset: range.end,
      quote,
    });
  }
  return { type: "located", spans };
};

/** How a highlight's style is drawn as a box over the canvas. */
export const MARK_STYLE_VARIANT = {
  highlight: "fill",
  underline: "underline",
  squiggly: "wavy",
  strikethrough: "strike",
} as const satisfies Record<ReaderAnnotationStyle, TextMarkVariant>;

export const MARK_COLOR_TONE = {
  yellow: "option-yellow",
  green: "option-green",
  sky: "option-sky",
  violet: "option-violet",
  red: "option-red",
} as const satisfies Record<ReaderAnnotationColor, TextMarkTone>;
