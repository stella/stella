/**
 * Where a mark on a matter document's PDF sits on a page, shared by the web
 * viewer that draws it and the API that writes it into a downloaded copy, so
 * the two cannot place the same mark differently.
 *
 * A mark's anchor is a page and UTF-16 offsets into that page's text as LibPDF
 * extracts it, the quoted words, and the digest of the page text it was
 * placed on. Both sides read the same bytes with the same extractor and keep
 * the glyph box behind every unit, so placing a mark is a slice of those
 * boxes, in PDF user space.
 */

import { panic } from "better-result";

/** A glyph's box in PDF user space: origin bottom left, in points. */
export type PdfTextBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * The shape of LibPDF's `PDFPage.extractText()` this module reads. Written
 * out structurally so the contract does not depend on the PDF library.
 */
export type ExtractedPdfPageText = {
  lines: readonly {
    spans: readonly {
      chars: readonly { char: string; bbox: PdfTextBox }[];
    }[];
  }[];
};

/**
 * A page's text as LibPDF extracts it, with the glyph box behind each UTF-16
 * unit (null for the newline between lines). The text is LibPDF's own page
 * text: lines of span characters joined by "\n".
 */
export type PdfPageGlyphText = {
  boxesByOffset: (PdfTextBox | null)[];
  text: string;
};

export const readPdfPageGlyphText = (
  pageText: ExtractedPdfPageText,
): PdfPageGlyphText => {
  const boxesByOffset: (PdfTextBox | null)[] = [];
  const textParts: string[] = [];

  for (const [lineIndex, line] of pageText.lines.entries()) {
    if (lineIndex > 0) {
      textParts.push("\n");
      boxesByOffset.push(null);
    }

    for (const span of line.spans) {
      for (const character of span.chars) {
        textParts.push(character.char);
        for (const _codeUnit of character.char.split("")) {
          boxesByOffset.push(character.bbox);
        }
      }
    }
  }

  return { boxesByOffset, text: textParts.join("") };
};

const MIN_SAME_LINE_OVERLAP_RATIO = 0.5;
const MAX_INLINE_GAP_HEIGHT_RATIO = 0.75;

const verticalOverlap = (first: PdfTextBox, second: PdfTextBox) =>
  Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) -
      Math.max(first.y, second.y),
  );

const canMergeBoxes = (current: PdfTextBox, next: PdfTextBox): boolean => {
  const minimumHeight = Math.min(current.height, next.height);
  const horizontalGap = Math.max(
    0,
    next.x - (current.x + current.width),
    current.x - (next.x + next.width),
  );
  const maximumInlineGap =
    Math.max(current.height, next.height) * MAX_INLINE_GAP_HEIGHT_RATIO;

  return (
    minimumHeight > 0 &&
    verticalOverlap(current, next) / minimumHeight >=
      MIN_SAME_LINE_OVERLAP_RATIO &&
    horizontalGap <= maximumInlineGap
  );
};

/** Glyph boxes in reading order, merged into one box per run on a line. */
export const mergePdfTextBoxes = (
  boxes: readonly PdfTextBox[],
): PdfTextBox[] => {
  const merged: PdfTextBox[] = [];

  for (const box of boxes) {
    if (box.width <= 0 || box.height <= 0) {
      continue;
    }

    const current = merged.at(-1);
    if (!current || !canMergeBoxes(current, box)) {
      merged.push({ ...box });
      continue;
    }

    const right = Math.max(current.x + current.width, box.x + box.width);
    const top = Math.max(current.y + current.height, box.y + box.height);
    current.x = Math.min(current.x, box.x);
    current.y = Math.min(current.y, box.y);
    current.width = right - current.x;
    current.height = top - current.y;
  }

  return merged;
};

export type TextRange = { start: number; end: number };

export type MarkAnchor = {
  /** The file the mark was placed on. */
  fieldId: string;
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  quote: string;
  pageTextSha256: string;
};

export type MarkPageText = PdfPageGlyphText & { sha256: string };

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
  | { type: "placed"; boxes: PdfTextBox[]; range: TextRange }
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

const boxesFor = (page: PdfPageGlyphText, range: TextRange): PdfTextBox[] =>
  mergePdfTextBoxes(
    page.boxesByOffset
      .slice(range.start, range.end)
      .filter((box): box is PdfTextBox => box !== null),
  );

const placed = (
  page: PdfPageGlyphText,
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
  /** The text of the anchor's page in the file shown; undefined while it is
   *  read or when the file has no such page. */
  page: MarkPageText | undefined;
  /** The page texts are read, so a missing page is truly missing. */
  pagesRead: boolean;
  /** The file being shown or downloaded. */
  viewedFieldId: string;
};

/**
 * Where a mark sits on the file shown. A page that reads exactly as it did
 * when the mark was made (the same digest, on this file or another
 * version's) takes the stored offsets as they are. This file's page read
 * differently (a newer extractor) still shows the quoted words where they
 * are found nearest their old place. Another version's page that reads
 * differently is not this mark's text: the mark is detached, never drawn
 * over other words.
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
