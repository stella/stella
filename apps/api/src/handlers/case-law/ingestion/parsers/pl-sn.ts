// parser-output-unchanged: [pl-kis] the Supreme Court page reading is opt-in; the default reading is byte-identical, pinned by a recorded-output digest test.
// parser-output-unchanged: [pl-uokik] the Supreme Court page reading is opt-in; the default reading is byte-identical, pinned by a recorded-output digest test.
// parser-output-unchanged: [cz-uohs] reads through extractPlPdfSeparatedContent, which the Supreme Court page reading never reaches.
/**
 * Polish Supreme Court (Sąd Najwyższy) document reader.
 *
 * sn.pl serves each decision as a PDF with a real text layer, and nothing
 * richer: the portal's own "HTML version" is the same PDF re-rendered as
 * absolutely positioned one-line divs, so it carries no structure the text
 * layer does not already state.
 *
 * What the text layer does state is the publisher's own typesetting: a
 * paragraph's first line is indented past the body margin, paragraphs are
 * separated by empty lines, and the thesis, the docket and the section
 * markers are set in bold. This module reads those two signals — indent and
 * font — back into the markup the Polish parser already reads, and
 * `parsePlDecisionContent` does the rest. There is one Polish decision
 * parser, and this is not a second one.
 */

import { PDF } from "@libpdf/core";
import { panic } from "better-result";

// parser-output-unchanged: imports the document AST from its package owner
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { collapseSpacedLetters } from "@stll/text-normalize";

import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import {
  buildBoldRanges,
  normalizeSpanText,
} from "@/api/lib/legal-search/parsers/libpdf-utils";
import type { PdfSpan } from "@/api/lib/legal-search/parsers/libpdf-utils";

/** Publisher recorded on the AST, so a stored document names where it came from. */
const PL_SN_SOURCE_SYSTEM = "sn.pl";

/** A run of characters sharing one font weight. */
export type PlSnRun = {
  text: string;
  bold: boolean;
  footnoteReference?: string | undefined;
};

/**
 * One typeset line: its runs, and whether the publisher indented it.
 *
 * `blank` lines carry no runs and exist only as the paragraph separator the
 * source prints; keeping them is what lets paragraph assembly stay a reading
 * of the page rather than a guess about sentence endings.
 */
export type PlSnLine =
  | {
      readonly type: "text";
      readonly runs: readonly PlSnRun[];
      readonly indented: boolean;
      readonly footnote?:
        { readonly label: string; readonly noteId: string } | undefined;
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
const bodyMarginOf = (
  positions: readonly number[],
  preferHangingMargin = false,
): number => {
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
  if (preferHangingMargin) {
    const continuation = [...counts]
      .filter(
        ([position, count]) =>
          position - margin >= INDENT_THRESHOLD_PT &&
          position - margin <= INDENT_THRESHOLD_PT * 2 &&
          count >= best / 2,
      )
      .toSorted(([, left], [, right]) => right - left)
      .at(0);
    return continuation?.at(0) ?? margin;
  }
  return margin;
};

type ExtractedLine = {
  readonly spans: readonly PdfSpan[];
  readonly text: string;
  readonly x: number;
  /** Where the line ends; read only where block continuation is asked for. */
  readonly right?: number | undefined;
};

type PageFurnitureSpan = PdfSpan & {
  readonly bbox: PdfSpan["bbox"] & { readonly y: number };
};

type PageFurnitureLine = {
  readonly spans: readonly PageFurnitureSpan[];
  readonly text: string;
  readonly bbox: { readonly x: number; readonly y: number };
};

export type ExtractPlSnLinesOptions = {
  /**
   * Read the Supreme Court's page the way it is set, given the decision's
   * docket:
   *
   * - the running header atop every page after the first (`I CSK 2978/25 2`,
   *   or the bare `2`) is dropped rather than read into the paragraph it
   *   interrupts;
   * - empty lines at a page's edges, and empty lines set in small type,
   *   end no paragraph: the first set off the header and the empty footer,
   *   the second are spacing marks left inside running text;
   * - an indented block keeps its lines in one paragraph. The operative part
   *   is set as a block indented past the body margin, each point's first
   *   line indented again, so measured against the body margin every line
   *   of it reads as a first line. A line continues the one above it when
   *   that line ran out of room for this line's first word and this line
   *   sits no deeper than it.
   */
  readonly supremeCourt?: { readonly docket: string } | undefined;
};

/**
 * Whether a page's first line is its running header: the page's own number,
 * alone or after the docket. Requiring both the page's number and the
 * decision's docket is what keeps a line of text that merely ends in a
 * number in the text.
 */
const isRunningHeader = (
  text: string | undefined,
  docket: string,
  pageNumber: number,
): boolean => {
  const words = text?.trim().split(/\s+/u) ?? [];
  if (words.at(-1) !== String(pageNumber)) {
    return false;
  }
  const label = words.slice(0, -1).join(" ");
  return label === "" || label === docket.trim().split(/\s+/u).join(" ");
};

const PAGE_MARGIN_RATIO = 0.06;
const FOOTNOTE_ZONE_RATIO = 0.25;
const SMALL_TYPE_RATIO = 0.86;

const bodyFontSizeOf = (
  lines: readonly {
    readonly spans: readonly { fontSize: number; text: string }[];
  }[],
): number => {
  const counts = new Map<number, number>();
  for (const { spans } of lines) {
    for (const { fontSize, text } of spans) {
      const size = Math.round(fontSize * 10) / 10;
      counts.set(size, (counts.get(size) ?? 0) + text.trim().length);
    }
  }
  let bodySize = 0;
  let best = 0;
  for (const [size, count] of counts) {
    if (count > best) {
      bodySize = size;
      best = count;
    }
  }
  return bodySize;
};

export const withoutRaisedReferenceMarkers = (
  line: PageFurnitureLine,
  bodySize: number,
  footnoteLabels: ReadonlySet<string> = new Set(
    line.spans.map(({ text }) => text.trim()),
  ),
): PageFurnitureLine => {
  const bodySpans = line.spans.filter(
    ({ fontSize }) => fontSize > bodySize * SMALL_TYPE_RATIO,
  );
  const bodyY = Math.min(...bodySpans.map(({ bbox }) => bbox.y));
  const markerSpans = new Set(
    line.spans.filter(
      ({ bbox, fontSize, text }) =>
        footnoteLabels.has(text.trim()) &&
        fontSize <= bodySize * SMALL_TYPE_RATIO &&
        bbox.y > bodyY + bodySize * 0.2,
    ),
  );
  if (markerSpans.size === 0) {
    return line;
  }

  // Each span is located in the line from where the previous one ended, so
  // a marker removes its own occurrence, never equal digits earlier in the
  // line (a paragraph's "1." before its footnote mark "1"). A span the line
  // does not contain in order leaves the line as read.
  let text = "";
  let cursor = 0;
  for (const span of line.spans) {
    const at = line.text.indexOf(span.text, cursor);
    if (at === -1) {
      return line;
    }
    text += line.text.slice(cursor, at);
    if (!markerSpans.has(span)) {
      text += span.text;
    }
    cursor = at + span.text.length;
  }
  text += line.text.slice(cursor);
  return {
    ...line,
    spans: line.spans.filter((span) => !markerSpans.has(span)),
    text,
  };
};

/**
 * The runs of one line, with letter-spaced emphasis collapsed.
 *
 * This court sets its section markers letter by letter
 * (`U z a s a d n i e n i e`), which no search for the word matches and
 * which no heading rule recognises. Collapsed after the bold ranges are
 * mapped, because that mapping finds each span's text inside the line and
 * would miss it once the spacing is gone.
 */
const runsOfLine = (line: ExtractedLine): PlSnRun[] => {
  const ranges = buildBoldRanges([...line.spans], line.text);
  return ranges.flatMap((range) => {
    const text = collapseSpacedLetters(line.text.slice(range.start, range.end));
    return text.length === 0 ? [] : [{ text, bold: range.bold }];
  });
};

/**
 * Which departures from a page's body margin open a paragraph.
 *
 * The Supreme Court indents a paragraph's first line. Other publishers set
 * numbered paragraphs with a hanging indent instead: the number sits left of
 * the margin the paragraph's other lines share, so a first line departs from
 * it in the other direction.
 */
export const PL_PDF_PARAGRAPH_START = {
  INDENT: "indent",
  INDENT_OR_OUTDENT: "indent-or-outdent",
} as const;

export type PlPdfParagraphStart =
  (typeof PL_PDF_PARAGRAPH_START)[keyof typeof PL_PDF_PARAGRAPH_START];

const opensParagraph = (
  offset: number,
  paragraphStart: PlPdfParagraphStart,
): boolean => {
  switch (paragraphStart) {
    case PL_PDF_PARAGRAPH_START.INDENT:
      return offset >= INDENT_THRESHOLD_PT;
    case PL_PDF_PARAGRAPH_START.INDENT_OR_OUTDENT:
      return Math.abs(offset) >= INDENT_THRESHOLD_PT;
    default: {
      paragraphStart satisfies never;
      return panic(`Unhandled paragraph start: ${String(paragraphStart)}`);
    }
  }
};

/**
 * The x a document's full lines end at: the most common line end, since
 * justified running text outnumbers every short or centred line.
 */
const rightEdgeOf = (lines: readonly ExtractedLine[]): number | undefined => {
  const counts = new Map<number, number>();
  for (const { right, text } of lines) {
    if (right !== undefined && text.length > 0) {
      const rounded = Math.round(right);
      counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
    }
  }
  let edge: number | undefined;
  let best = 0;
  for (const [position, count] of counts) {
    if (count > best || (count === best && position > (edge ?? 0))) {
      edge = position;
      best = count;
    }
  }
  return edge;
};

/** A list point's own number or bullet: `2.`, `IV.`, `a)`, `–`. */
const LIST_MARKER = /^(?:(?:\d{1,3}|[IVXLC]{1,6}|\p{Ll})[.)]|[-–•])\s/u;

/** A line ending a sentence or a list point, closing quotes included. */
const ENDS_SENTENCE = /[.;:!?…]["”')\]]*$/u;
/** A capital, or an opening bracket or quote: also how a clerk's mark (`[SOP]`) starts. */
const STARTS_SENTENCE = /^[\p{Lu}[(„"]/u;

/**
 * Whether the line above ended only because `line`'s first word no longer
 * fit on it. A line that stopped short of that ended its paragraph.
 *
 * A short first word fits almost any gap, so a line that ended a sentence
 * before a capital or a list point is taken as the paragraph's end: two
 * paragraphs merged would hide the structure, where a missed continuation
 * only leaves the line break the reading had before.
 */
const ranOutOfRoom = (
  previous: ExtractedLine,
  line: ExtractedLine,
  rightEdge: number,
): boolean => {
  const opening = line.text.trimStart();
  if (
    previous.right === undefined ||
    line.right === undefined ||
    (ENDS_SENTENCE.test(previous.text.trimEnd()) &&
      (STARTS_SENTENCE.test(opening) || LIST_MARKER.test(opening)))
  ) {
    return false;
  }
  const firstWord = opening.split(/\s/u, 1).at(0) ?? "";
  const characterWidth = (line.right - line.x) / Math.max(1, line.text.length);
  return rightEdge - previous.right < (firstWord.length + 1) * characterWidth;
};

/**
 * Whether `line` opens a paragraph, where the indent alone misreads blocks
 * and lists.
 *
 * An indented line carries on the full line above it when it sits no
 * deeper than that line, or when that line is a list point's first line
 * set with a hanging indent. A short line above ended its paragraph, which
 * is what keeps two one-line points of an operative part apart. A list
 * point that starts at the margin opens a paragraph after a short line,
 * though nothing indents it.
 */
const opensBlockParagraph = (
  previous: ExtractedLine | undefined,
  line: ExtractedLine,
  indented: boolean,
  rightEdge: number,
): boolean => {
  if (previous === undefined || previous.text.length === 0) {
    return indented;
  }
  const full = ranOutOfRoom(previous, line, rightEdge);
  if (!indented) {
    return !full && LIST_MARKER.test(line.text.trimStart());
  }
  return !(
    full &&
    (line.x - previous.x < INDENT_THRESHOLD_PT ||
      LIST_MARKER.test(previous.text.trimStart()))
  );
};

/** Read one page's lines, keeping blanks and the indent decision. */
const readPage = (
  lines: readonly ExtractedLine[],
  paragraphStart: PlPdfParagraphStart,
  documentBodyMargin?: number,
  blocks?: {
    readonly rightEdge: number;
    /** The previous page's last line, which a block may run on from. */
    readonly carried: ExtractedLine | undefined;
  },
): PlSnLine[] => {
  const margin =
    documentBodyMargin ??
    bodyMarginOf(lines.filter(({ text }) => text.length > 0).map(({ x }) => x));
  return lines.map((line, index) => {
    if (line.text.length === 0) {
      return { type: "blank" as const };
    }
    const indented = opensParagraph(line.x - margin, paragraphStart);
    return {
      type: "text" as const,
      runs: runsOfLine(line),
      indented:
        blocks === undefined
          ? indented
          : opensBlockParagraph(
              index === 0 ? blocks.carried : lines[index - 1],
              line,
              indented,
              blocks.rightEdge,
            ),
    };
  });
};

type SeparatedPdfContent = {
  body: PlSnLine[];
  notes: PlSnLine[];
};

/** Split at references before bold runs can merge across the printed mark. */
const runsWithReferences = (
  line: PageFurnitureLine,
  markers: ReadonlySet<PageFurnitureSpan>,
): PlSnRun[] => {
  const runs: PlSnRun[] = [];
  let cursor = 0;
  let start = 0;
  let spans: PageFurnitureSpan[] = [];
  for (const span of line.spans) {
    const at = line.text.indexOf(span.text, cursor);
    if (at === -1) {
      return panic("PDF span is missing from its extracted line");
    }
    cursor = at + span.text.length;
    if (!markers.has(span)) {
      spans.push(span);
      continue;
    }
    runs.push(
      ...runsOfLine({
        spans,
        text: line.text
          .slice(start, at)
          .replace(/\u00a0/gu, " ")
          .replace(/ {2,}/gu, " "),
        x: line.bbox.x,
      }),
    );
    runs.push({
      text: span.text.trim(),
      bold: false,
      footnoteReference: span.text.trim(),
    });
    spans = [];
    start = cursor;
  }
  runs.push(
    ...runsOfLine({
      spans,
      text: line.text
        .slice(start)
        .replace(/\u00a0/gu, " ")
        .replace(/ {2,}/gu, " "),
      x: line.bbox.x,
    }),
  );
  return runs;
};

/** Keep notes and their references while discarding only margin furniture. */
const readPagesWithFootnotes = (
  pages: readonly {
    height: number;
    lines: readonly PageFurnitureLine[];
  }[],
  paragraphStart: PlPdfParagraphStart,
): SeparatedPdfContent => {
  const labels = new Set<string>();
  const noteLabelLines = new Set<PageFurnitureLine>();
  for (const { height, lines } of pages) {
    const bodySize = bodyFontSizeOf(lines);
    for (const [index, line] of lines.entries()) {
      const label = normalizeSpanText(line.text).trim();
      const next = lines
        .slice(index + 1)
        .find(({ text }) => text.trim().length > 0);
      if (
        /^\d+$/u.test(label) &&
        line.bbox.y >= height * PAGE_MARGIN_RATIO &&
        line.bbox.y < height * FOOTNOTE_ZONE_RATIO &&
        line.spans.every(
          ({ fontSize }) => fontSize <= bodySize * SMALL_TYPE_RATIO,
        ) &&
        next?.spans.every(
          ({ fontSize }) => fontSize <= bodySize * SMALL_TYPE_RATIO,
        )
      ) {
        labels.add(label);
        noteLabelLines.add(line);
      }
    }
  }

  const bodyLines: (ExtractedLine & { runs?: PlSnRun[] })[] = [];
  const notes: PlSnLine[] = [];
  let currentNote: { label: string; noteId: string } | undefined;

  for (const { height, lines } of pages) {
    const bodySize = bodyFontSizeOf(lines);
    let beforeBody = true;
    for (const original of lines) {
      if (
        original.bbox.y < height * PAGE_MARGIN_RATIO ||
        original.bbox.y > height * (1 - PAGE_MARGIN_RATIO)
      ) {
        continue;
      }
      const text = normalizeSpanText(original.text);
      const nonBlank = original.spans.filter(
        ({ text: spanText }) => spanText.trim().length > 0,
      );
      const small =
        nonBlank.length > 0 &&
        nonBlank.every(
          ({ fontSize }) => fontSize <= bodySize * SMALL_TYPE_RATIO,
        );

      if (
        noteLabelLines.has(original) ||
        (small &&
          currentNote !== undefined &&
          (original.bbox.y < height * FOOTNOTE_ZONE_RATIO ||
            (beforeBody && !/^\d/u.test(text.trim()))) &&
          !/^\d+(?:\s+\d+)*$/u.test(text.trim()))
      ) {
        const label = text.trim();
        if (labels.has(label)) {
          currentNote = { label, noteId: `footnote-${label}` };
        } else if (currentNote !== undefined) {
          notes.push({
            type: "text",
            runs: runsOfLine({
              spans: original.spans,
              text,
              x: original.bbox.x,
            }),
            indented: false,
            footnote: currentNote,
          });
        }
        continue;
      }

      if (small) {
        const markers = text.trim().split(/\s+/u);
        if (markers.every((marker) => labels.has(marker))) {
          const previous = bodyLines.findLast(
            ({ text: bodyText }) => bodyText.trim().length > 0,
          );
          if (previous !== undefined) {
            previous.runs ??= runsOfLine(previous);
            previous.runs.push(
              ...markers.map((label) => ({
                text: label,
                bold: false,
                footnoteReference: label,
              })),
            );
          }
          continue;
        }
      }

      if (text.trim().length > 0) {
        beforeBody = false;
        currentNote = undefined;
      }
      const markerSpans = original.spans.filter(
        ({ bbox, fontSize, text: spanText }) =>
          labels.has(spanText.trim()) &&
          fontSize <= bodySize * SMALL_TYPE_RATIO &&
          bbox.y > original.bbox.y + bodySize * 0.2,
      );
      const cleaned =
        markerSpans.length === 0
          ? original
          : withoutRaisedReferenceMarkers(original, bodySize, labels);
      bodyLines.push({
        spans: cleaned.spans,
        text: normalizeSpanText(cleaned.text),
        x: cleaned.bbox.x,
        ...(markerSpans.length > 0
          ? { runs: runsWithReferences(original, new Set(markerSpans)) }
          : {}),
      });
    }
  }

  const documentBodyMargin = bodyMarginOf(
    bodyLines.filter(({ text }) => text.length > 0).map(({ x }) => x),
    paragraphStart === PL_PDF_PARAGRAPH_START.INDENT_OR_OUTDENT,
  );
  const body = readPage(bodyLines, paragraphStart, documentBodyMargin).map(
    (line, index): PlSnLine => {
      const runs = bodyLines.at(index)?.runs;
      return line.type !== "text" || runs === undefined
        ? line
        : {
            ...line,
            runs,
          };
    },
  );
  return { body, notes };
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
export const assemblePlSnParagraphs = (
  lines: readonly PlSnLine[],
): PlSnRun[][] => {
  const paragraphs: PlSnRun[][] = [];
  let current: PlSnRun[] | undefined;

  // Copied rather than shared: joining a broken word rewrites the run it
  // lands in, and the lines handed in are the caller's to keep.
  const copyRun = ({ bold, text, footnoteReference }: PlSnRun): PlSnRun => ({
    bold,
    text,
    ...(footnoteReference === undefined ? {} : { footnoteReference }),
  });

  for (const line of lines) {
    if (line.type === "blank") {
      current = undefined;
      continue;
    }
    if (current === undefined || line.indented) {
      current = [];
      paragraphs.push(current);
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
    if (
      previous.bold === head.bold &&
      previous.footnoteReference === undefined &&
      head.footnoteReference === undefined
    ) {
      previous.text += separator + head.text;
    } else {
      current.push({ text: separator + head.text, bold: head.bold });
    }
    current.push(...tail.map(copyRun));
  }

  return paragraphs.filter((runs) =>
    runs.some(({ text }) => text.trim().length > 0),
  );
};

/**
 * The paragraphs as markup `parsePlDecisionContent` reads: a `<p>` each, with
 * the publisher's bold kept, since that is what the parser keys the operative
 * part off where the decision prints no section heading.
 */
export const plSnParagraphsToHtml = (
  paragraphs: readonly PlSnRun[][],
): string =>
  paragraphs
    .map(
      (runs) =>
        `<p>${runs
          .map(({ bold, text }) =>
            bold ? `<b>${escapeHtml(text)}</b>` : escapeHtml(text),
          )
          .join("")}</p>`,
    )
    .join("");

/** Every line of every page, in reading order. */
export const extractPlSnLines = async (
  pdfBytes: Uint8Array,
  paragraphStart: PlPdfParagraphStart = PL_PDF_PARAGRAPH_START.INDENT,
  options: ExtractPlSnLinesOptions = {},
): Promise<PlSnLine[]> => {
  const pdf = await PDF.load(pdfBytes);
  const pages = pdf.getPages().map((page) =>
    page.extractText().lines.map((line): ExtractedLine => ({
      spans: line.spans,
      text: normalizeSpanText(line.text),
      x: line.bbox.x,
      right: line.bbox.x + line.bbox.width,
    })),
  );
  const { supremeCourt } = options;
  if (supremeCourt === undefined) {
    return pages.flatMap((lines) => readPage(lines, paragraphStart));
  }

  const bodySize = bodyFontSizeOf(pages.flat());
  const bodyPages = pages.map((lines, pageIndex) => {
    const first = lines.findIndex(({ text }) => text.length > 0);
    const start =
      pageIndex > 0 &&
      isRunningHeader(lines[first]?.text, supremeCourt.docket, pageIndex + 1)
        ? lines.findIndex(({ text }, index) => index > first && text.length > 0)
        : first;
    const end = lines.findLastIndex(({ text }) => text.length > 0);
    return start === -1
      ? []
      : lines
          .slice(start, end + 1)
          .filter(
            ({ spans, text }) =>
              text.length > 0 ||
              !spans.every(
                ({ fontSize }) => fontSize <= bodySize * SMALL_TYPE_RATIO,
              ),
          );
  });
  const rightEdge = rightEdgeOf(bodyPages.flat());
  return bodyPages.flatMap((lines, pageIndex) =>
    readPage(
      lines,
      paragraphStart,
      undefined,
      rightEdge === undefined
        ? undefined
        : {
            rightEdge,
            carried:
              pageIndex === 0 ? undefined : bodyPages[pageIndex - 1]?.at(-1),
          },
    ),
  );
};

export type PlPdfSeparatedContent = {
  body: PlSnLine[];
  notes: PlSnLine[];
};

/** Structured form for adapters that emit linked footnote blocks. */
export const extractPlPdfSeparatedContent = async (
  pdfBytes: Uint8Array,
  paragraphStart: PlPdfParagraphStart,
): Promise<PlPdfSeparatedContent> => {
  const pdf = await PDF.load(pdfBytes);
  const pages = pdf.getPages().map((page) => {
    const { height, lines } = page.extractText();
    return { height, lines };
  });
  return readPagesWithFootnotes(pages, paragraphStart);
};

type ParsePlSnDecisionInput = {
  pdfBytes: Uint8Array;
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
  documentUrl: string | undefined;
  documentId: string;
};

type ParsePlSnDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

export const parsePlSnDecisionPdf = async (
  input: ParsePlSnDecisionInput,
): Promise<ParsePlSnDecisionOutput> => {
  const paragraphs = assemblePlSnParagraphs(
    await extractPlSnLines(input.pdfBytes, PL_PDF_PARAGRAPH_START.INDENT, {
      supremeCourt: { docket: input.caseNumber },
    }),
  );
  return parsePlDecisionContent({
    caseNumber: input.caseNumber,
    // Poland issues no ECLI, so no Polish decision carries one.
    ecli: undefined,
    court: input.court,
    decisionDate: input.decisionDate,
    decisionType: input.decisionType,
    sourceUrl: input.sourceUrl,
    documentUrl: input.documentUrl,
    content: plSnParagraphsToHtml(paragraphs),
    // sn.pl indexes neither, so there is nothing to carry onto the AST.
    keywords: [],
    statutes: [],
    documentId: input.documentId,
    sourceSystem: PL_SN_SOURCE_SYSTEM,
  });
};
