/** Shared PDF text-layer reading and paragraph assembly. */

import { PDF } from "@libpdf/core";
import { panic } from "better-result";

import type { ParagraphNote } from "@stll/legal-ast/document-ast";
import { collapseSpacedLetters } from "@stll/text-normalize";

import {
  buildBoldRanges,
  normalizeSpanText,
} from "@/api/lib/legal-search/parsers/libpdf-utils";
import type { PdfSpan } from "@/api/lib/legal-search/parsers/libpdf-utils";

/** A run of characters sharing one font weight. */
export type PdfParagraphRun = { text: string; bold: boolean };

/**
 * One typeset line: its runs, and whether the publisher indented it.
 *
 * `blank` lines carry no runs and exist only as the paragraph separator the
 * source prints; keeping them is what lets paragraph assembly stay a reading
 * of the page rather than a guess about sentence endings.
 */
export type PdfParagraphLine =
  | {
      readonly type: "text";
      readonly runs: readonly PdfParagraphRun[];
      readonly indented: boolean;
      readonly note?: ParagraphNote;
      readonly source?: {
        readonly pageIndex: number;
        readonly bbox: { x: number; y: number; width: number; height: number };
        readonly spans: readonly PdfSpan[];
      };
    }
  | { readonly type: "blank" };

/**
 * A line ending in a hyphen that follows a letter: this publisher's line
 * break inside a word. The two halves join with no space between them —
 * "rozpo- znaniu" is a word no search finds again — and the hyphen itself
 * survives only where the break fell inside a real compound.
 */
const SOFT_HYPHEN_END = /\p{L}-$/u;

/**
 * A continuation in lower case resumes a broken word, so the hyphen goes
 * ("rozpo-" + "znaniu"). One in upper case is the second half of a compound
 * the publisher happened to break there, so the hyphen stays
 * ("Administracyjnego-" + "Ośrodka").
 */
const RESUMES_A_BROKEN_WORD = /^\p{Ll}/u;

/**
 * How far past the body margin a first line has to sit to read as an indent.
 *
 * The observed step is a full tab (72pt body, 108pt indent). Half of that is
 * comfortably above the sub-point jitter the extractor reports for lines that
 * begin at the same margin, and comfortably below a real indent.
 */
const INDENT_THRESHOLD_PT = 18;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>]/gu, (character) => HTML_ESCAPES[character] ?? character);

/**
 * The x every body line of a page starts at: the most common one.
 *
 * Read per page rather than per document because a decision's pages are not
 * all set the same way — a first page carrying a centred heading block has a
 * different spread of positions than a page of running text.
 */
const bodyMarginOf = (positions: readonly number[]): number => {
  const counts = new Map<number, number>();
  for (const position of positions) {
    const rounded = Math.round(position);
    counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
  }
  let margin = positions.at(0) ?? 0;
  let best = 0;
  for (const [position, count] of counts) {
    if (count > best || (count === best && position < margin)) {
      margin = position;
      best = count;
    }
  }
  return margin;
};

type ExtractedLine = {
  readonly spans: readonly PdfSpan[];
  readonly text: string;
  readonly x: number;
  readonly source: NonNullable<
    Extract<PdfParagraphLine, { type: "text" }>["source"]
  >;
};

/**
 * The runs of one line, with letter-spaced emphasis collapsed.
 *
 * Publishers can set their section markers letter by letter
 * (`U z a s a d n i e n i e`), which no search for the word matches and
 * which no heading rule recognises. Collapsed after the bold ranges are
 * mapped, because that mapping finds each span's text inside the line and
 * would miss it once the spacing is gone.
 */
const runsOfLine = (line: ExtractedLine): PdfParagraphRun[] => {
  const ranges = buildBoldRanges([...line.spans], line.text);
  return ranges.flatMap((range) => {
    const text = collapseSpacedLetters(line.text.slice(range.start, range.end));
    return text.length === 0 ? [] : [{ text, bold: range.bold }];
  });
};

/**
 * Which departures from a page's body margin open a paragraph.
 *
 * Some publishers indent a paragraph's first line. Others set
 * numbered paragraphs with a hanging indent instead: the number sits left of
 * the margin the paragraph's other lines share, so a first line departs from
 * it in the other direction.
 */
export const PDF_PARAGRAPH_START = {
  INDENT: "indent",
  INDENT_OR_OUTDENT: "indent-or-outdent",
} as const;

export type PdfParagraphStart =
  (typeof PDF_PARAGRAPH_START)[keyof typeof PDF_PARAGRAPH_START];

const opensParagraph = (
  offset: number,
  paragraphStart: PdfParagraphStart,
): boolean => {
  switch (paragraphStart) {
    case PDF_PARAGRAPH_START.INDENT:
      return offset >= INDENT_THRESHOLD_PT;
    case PDF_PARAGRAPH_START.INDENT_OR_OUTDENT:
      return Math.abs(offset) >= INDENT_THRESHOLD_PT;
    default: {
      paragraphStart satisfies never;
      return panic(`Unhandled paragraph start: ${String(paragraphStart)}`);
    }
  }
};

/** Read one page's lines, keeping blanks and the indent decision. */
const readPage = (
  lines: readonly ExtractedLine[],
  paragraphStart: PdfParagraphStart,
): PdfParagraphLine[] => {
  const margin = bodyMarginOf(
    lines.filter(({ text }) => text.length > 0).map(({ x }) => x),
  );
  return lines.map((line) =>
    line.text.length === 0
      ? { type: "blank" as const }
      : {
          type: "text" as const,
          runs: runsOfLine(line),
          source: line.source,
          indented: opensParagraph(line.x - margin, paragraphStart),
        },
  );
};

/**
 * Join typeset lines back into the paragraphs they were broken from.
 *
 * A paragraph ends where the publisher ended it: at an empty line, or at the
 * next indented first line. Everything else continues the paragraph it is
 * printed under, page boundaries included — a paragraph that runs over a page
 * break is one paragraph, and the source states as much by not indenting the
 * line that continues it.
 */
export type PdfParagraph = { runs: PdfParagraphRun[]; note?: ParagraphNote };

export const assemblePdfParagraphs = (
  lines: readonly PdfParagraphLine[],
): PdfParagraph[] => {
  const paragraphs: PdfParagraph[] = [];
  let current: PdfParagraphRun[] | undefined;
  let currentNote: ParagraphNote | undefined;

  // Copied rather than shared: joining a broken word rewrites the run it
  // lands in, and the lines handed in are the caller's to keep.
  const copyRun = ({ bold, text }: PdfParagraphRun): PdfParagraphRun => ({
    bold,
    text,
  });

  for (const line of lines) {
    if (line.type === "blank") {
      current = undefined;
      continue;
    }
    const sameNote =
      currentNote?.label === line.note?.label &&
      currentNote?.noteId === line.note?.noteId;
    if (current === undefined || line.indented || !sameNote) {
      current = [];
      currentNote = line.note;
      paragraphs.push(
        line.note === undefined
          ? { runs: current }
          : { runs: current, note: line.note },
      );
      current.push(...line.runs.map(copyRun));
      continue;
    }

    const [head, ...tail] = line.runs;
    if (head === undefined) {
      continue;
    }
    const previous = current.at(-1);
    if (previous === undefined) {
      current.push(copyRun(head), ...tail.map(copyRun));
      continue;
    }

    const brokenWord = SOFT_HYPHEN_END.test(previous.text);
    if (brokenWord && RESUMES_A_BROKEN_WORD.test(head.text)) {
      previous.text = previous.text.slice(0, -1);
    }
    const separator = brokenWord ? "" : " ";
    if (previous.bold === head.bold) {
      previous.text += separator + head.text;
    } else {
      current.push({ text: separator + head.text, bold: head.bold });
    }
    current.push(...tail.map(copyRun));
  }

  return paragraphs.filter(({ runs }) =>
    runs.some(({ text }) => text.trim().length > 0),
  );
};

/**
 * Paragraph markup with the publisher's bold emphasis preserved.
 */
export const pdfParagraphsToHtml = (
  paragraphs: readonly PdfParagraph[],
): string =>
  paragraphs
    .map(
      ({ runs }) =>
        `<p>${runs
          .map(({ bold, text }) =>
            bold ? `<b>${escapeHtml(text)}</b>` : escapeHtml(text),
          )
          .join("")}</p>`,
    )
    .join("");

export type PdfParagraphExtractionOptions = {
  paragraphStart?: PdfParagraphStart;
  footnotes?: "detect" | "none";
};

const FOOTNOTE_REGION_START = 0.75;
const FOOTNOTE_FONT_RATIO = 0.9;

const FOOTNOTE_MARKER = /^(\[\d{1,3}\]|\d{1,3}[.)]?|[*†‡]+)\s+(?=\S)/u;

/** Detect only small-font notes with a printed marker near the page's end. */
const detectFootnotes = (lines: PdfParagraphLine[]): PdfParagraphLine[] => {
  const textLines = lines.filter((line) => line.type === "text");
  const firstY = textLines.at(0)?.source?.bbox.y;
  const lastY = textLines.at(-1)?.source?.bbox.y;
  if (firstY === undefined || lastY === undefined || firstY === lastY) {
    return lines;
  }
  // Notes must not vote for their own font size, especially on sparse pages.
  const sizes = textLines.flatMap(({ source }) => {
    if (
      source === undefined ||
      (source.bbox.y - firstY) / (lastY - firstY) >= FOOTNOTE_REGION_START
    ) {
      return [];
    }
    return source.spans.map(({ fontSize }) => fontSize);
  });
  const bodySize = bodyMarginOf(sizes);
  let note: ParagraphNote | undefined;
  return lines.map((line) => {
    if (line.type === "blank" || line.source === undefined) {
      return line;
    }
    const progress = (line.source.bbox.y - firstY) / (lastY - firstY);
    const small =
      line.source.spans.length > 0 &&
      line.source.spans.every(
        ({ fontSize }) => fontSize < bodySize * FOOTNOTE_FONT_RATIO,
      );
    const label = FOOTNOTE_MARKER.exec(
      line.runs.map(({ text }) => text).join(""),
    )?.at(1);
    if (progress >= FOOTNOTE_REGION_START && small && label !== undefined) {
      note = {
        type: "footnote",
        label,
        noteId: `pdf-note-${line.source.pageIndex}-${line.source.bbox.y}`,
      };
    } else if (!small) {
      note = undefined;
    }
    return note === undefined ? line : { ...line, note };
  });
};

/** Every line of every page, in reading order. */
export const extractPdfParagraphLines = async (
  pdfBytes: Uint8Array,
  options: PdfParagraphExtractionOptions = {},
): Promise<PdfParagraphLine[]> => {
  const pdf = await PDF.load(pdfBytes);
  return pdf.getPages().flatMap((page, pageIndex) => {
    const { lines } = page.extractText();
    const pageLines = readPage(
      lines.map((line) => ({
        spans: line.spans,
        text: normalizeSpanText(line.text),
        x: line.bbox.x,
        source: { pageIndex, bbox: line.bbox, spans: line.spans },
      })),
      options.paragraphStart ?? PDF_PARAGRAPH_START.INDENT,
    );
    return options.footnotes === "detect"
      ? detectFootnotes(pageLines)
      : pageLines;
  });
};
