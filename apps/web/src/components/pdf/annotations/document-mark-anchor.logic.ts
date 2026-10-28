/**
 * Between a selection in the PDF viewer and a mark's anchor.
 *
 * An anchor is a page and UTF-16 offsets into that page's text as LibPDF
 * extracts it; where an anchor is drawn is `placeMark` in
 * `@stll/api-contract/pdf-mark-placement`, shared with the API that writes
 * marks into a downloaded copy.
 *
 * A selection in pdf.js's text layer becomes an anchor by finding the
 * selected words in LibPDF's page text: the two extractors agree on the
 * characters but not always on the whitespace between them, so the words are
 * matched with whitespace ignored, nearest the place on the page where the
 * selection began.
 */

import { READER_ANNOTATION_QUOTE_MAX_LENGTH } from "@stll/api-contract/legal-reader-annotations";
import type {
  ReaderAnnotationColor,
  ReaderAnnotationStyle,
} from "@stll/api-contract/legal-reader-annotations";
import { findWordsOnPage } from "@stll/api-contract/pdf-mark-placement";
import type { TextMarkTone, TextMarkVariant } from "@stll/ui/text-mark";

import type { PageSearchText } from "@/lib/pdf/pdf-search";

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
