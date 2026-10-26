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
  /** Set raised in small type: an article's or a unit's index (`394¹`). */
  superscript?: true | undefined;
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
  /**
   * Small digits the text layer printed apart from the line's own text,
   * placed back into it.
   */
  readonly marks?: readonly LineMark[] | undefined;
  /** The line's height up the page; read only where spacing is asked for. */
  readonly y?: number | undefined;
  /**
   * Where the line's first printed character starts: past `x` where the
   * line opens with spaces typed as an indent.
   */
  readonly printedX?: number | undefined;
};

/**
 * Digits set back into their line, placed by how many of its printed
 * characters (whitespace aside) stand before them: counting printed
 * characters survives the spacing the line's text is normalised with.
 *
 * - `superscript`: raised as an index or a reference (`394¹`);
 * - `on-line`: small digits the text layer read apart from the line that are
 *   still its text, a number's next group (`10 000`) or digits not raised
 *   enough to be an index. `spaced` where the type sets them a space apart
 *   from what precedes them.
 */
type LineMark =
  | {
      readonly type: "superscript";
      readonly after: number;
      readonly text: string;
    }
  | {
      readonly type: "on-line";
      readonly after: number;
      readonly text: string;
      readonly spaced: boolean;
    };

type SuperscriptMark = Extract<LineMark, { type: "superscript" }>;

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
  text: string,
  docket: string,
  pageNumber: number,
): boolean => {
  const words = text.trim().split(/\s+/u);
  if (words.at(-1) !== String(pageNumber)) {
    return false;
  }
  const label = words.slice(0, -1).join(" ");
  return label === "" || label === docket.trim().split(/\s+/u).join(" ");
};

const PAGE_MARGIN_RATIO = 0.06;
/**
 * How far down the page a running header may sit. The Supreme Court prints it
 * about 6% down and starts the body near 12%; a tenth keeps the two apart.
 */
const RUNNING_HEADER_ZONE_RATIO = 0.1;
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
  const runs = ranges.flatMap((range) => {
    const text = collapseSpacedLetters(line.text.slice(range.start, range.end));
    return text.length === 0 ? [] : [{ text, bold: range.bold }];
  });
  return line.marks === undefined ? runs : withMarks(runs, line.marks);
};

const runOfMark = (mark: LineMark, bold: boolean): PlSnRun => {
  switch (mark.type) {
    case "superscript":
      return { text: mark.text, bold, superscript: true };
    case "on-line":
      return { text: mark.spaced ? ` ${mark.text}` : mark.text, bold };
    default: {
      mark satisfies never;
      return panic(`Unhandled line mark: ${JSON.stringify(mark)}`);
    }
  }
};

/**
 * The runs with each mark set in after the printed character it follows.
 * Collapsing letter spacing removes only whitespace, so the count of printed
 * characters still finds the place.
 */
const withMarks = (
  runs: readonly PlSnRun[],
  marks: readonly LineMark[],
): PlSnRun[] => {
  const pending = marks.toSorted((left, right) => left.after - right.after);
  const out: PlSnRun[] = [];
  let printed = 0;
  const setDue = (bold: boolean): void => {
    while (pending.length > 0 && (pending.at(0)?.after ?? 0) <= printed) {
      const mark = pending.shift();
      if (mark !== undefined) {
        out.push(runOfMark(mark, bold));
      }
    }
  };
  for (const run of runs) {
    setDue(run.bold);
    let start = 0;
    let end = 0;
    for (const character of run.text) {
      end += character.length;
      if (/\s/u.test(character)) {
        continue;
      }
      printed += 1;
      if ((pending.at(0)?.after ?? Number.POSITIVE_INFINITY) <= printed) {
        out.push({ ...run, text: run.text.slice(start, end) });
        setDue(run.bold);
        start = end;
      }
    }
    if (start < run.text.length) {
      out.push({ ...run, text: run.text.slice(start) });
    }
  }
  setDue(runs.at(-1)?.bold ?? false);
  return out;
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

/** A point numbered in a way no wrapped sentence starts: `2.`, `2)`, `a)`. */
const NUMBERED_POINT = /^(?:\d{1,3}[.)]|\p{Ll}\))\s/u;

/** A line ending on a unit a number follows: `art.`, `ust.`, `pkt`, `§`, `nr`. */
const TAKES_A_NUMBER =
  /(?:(?:^|\s)(?:art|ust|pkt|lit|poz|nr|zd|par|rozdz|tom|str|s|k)\.?|§)$/iu;

/** How a publisher marks the points and paragraphs a line can open. */
type PointMarkers = {
  /** A list point's own number or bullet. */
  readonly list: RegExp;
  /** A number no wrapped sentence starts with. */
  readonly numbered: RegExp;
  /**
   * The number a publisher hangs out left of each paragraph: it opens one
   * where the line below starts further right. A sentence can wrap onto the
   * same characters (`w pkt 3 podpkt.` / `(1) i (2) pisma`), set flush with
   * the lines around it, so the characters alone are not a point.
   */
  readonly paragraphNumber?: RegExp | undefined;
};

const POINT_MARKERS: PointMarkers = {
  list: LIST_MARKER,
  numbered: NUMBERED_POINT,
};

/** The number an authority sets before each paragraph: `(12)`, `[12]`. */
const PARAGRAPH_NUMBER = /^(?:\(\d{1,3}\)|\[\d{1,3}\])\s/u;

const NUMBERED_PARAGRAPH_MARKERS: PointMarkers = {
  list: LIST_MARKER,
  numbered: NUMBERED_POINT,
  paragraphNumber: PARAGRAPH_NUMBER,
};

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
  markers: PointMarkers,
): boolean => {
  const opening = line.text.trimStart();
  if (
    previous.right === undefined ||
    line.right === undefined ||
    (ENDS_SENTENCE.test(previous.text.trimEnd()) &&
      (STARTS_SENTENCE.test(opening) || markers.list.test(opening)))
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
 * point opens a paragraph wherever it starts, though nothing indents it.
 */
const opensBlockParagraph = (
  {
    previous,
    line,
    next,
  }: {
    readonly previous: ExtractedLine | undefined;
    readonly line: ExtractedLine;
    /** The line below on the same page, where there is one. */
    readonly next: ExtractedLine | undefined;
  },
  indented: boolean,
  {
    rightEdge,
    markers,
  }: { readonly rightEdge: number; readonly markers: PointMarkers },
): boolean => {
  if (previous === undefined || previous.text.length === 0) {
    return indented;
  }
  // A numbered point opens its own paragraph however full the line above
  // ran, unless that line ended on a word the number belongs to (`art.`).
  // Dashes, initials (`C. B.`) and abbreviations (`w. z`) wrap inside
  // sentences, so only the full-line test reads those.
  if (
    (markers.numbered.test(line.text.trimStart()) &&
      !TAKES_A_NUMBER.test(previous.text.trimEnd())) ||
    (markers.paragraphNumber?.test(line.text.trimStart()) === true &&
      next !== undefined &&
      next.text.length > 0 &&
      next.x - line.x >= INDENT_THRESHOLD_PT)
  ) {
    return true;
  }
  const full = ranOutOfRoom(previous, line, rightEdge, markers);
  if (!indented) {
    return !full && markers.list.test(line.text.trimStart());
  }
  return !(
    full &&
    (line.x - previous.x < INDENT_THRESHOLD_PT ||
      markers.list.test(previous.text.trimStart()) ||
      markers.paragraphNumber?.test(previous.text.trimStart()) === true)
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
    /**
     * The document's usual distance from one line to the next, where the
     * publisher sets paragraphs apart by spacing rather than by blank lines.
     */
    readonly linePitch?: number | undefined;
    readonly markers?: PointMarkers | undefined;
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
    const above = lines[index - 1];
    const spacedApart =
      blocks?.linePitch !== undefined &&
      above?.y !== undefined &&
      line.y !== undefined &&
      above.y - line.y > blocks.linePitch * PARAGRAPH_SPACING_RATIO;
    return {
      type: "text" as const,
      runs: runsOfLine(line),
      indented:
        blocks === undefined
          ? indented
          : spacedApart ||
            opensBlockParagraph(
              {
                previous: index === 0 ? blocks.carried : above,
                line,
                next: lines[index + 1],
              },
              indented,
              {
                rightEdge: blocks.rightEdge,
                markers: blocks.markers ?? POINT_MARKERS,
              },
            ),
    };
  });
};

/**
 * How much further apart than its lines a paragraph is set from the next.
 * Observed: 20pt between paragraphs whose lines are 14pt apart.
 */
const PARAGRAPH_SPACING_RATIO = 1.25;

/**
 * The distance from one line of running text to the next that occurs most
 * often, read off lines that follow each other on a page. Undefined for a
 * document of no two consecutive lines.
 */
const linePitchOf = (
  pages: readonly (readonly ExtractedLine[])[],
): number | undefined => {
  const counts = new Map<number, number>();
  for (const lines of pages) {
    for (const [index, line] of lines.entries()) {
      const above = lines[index - 1];
      if (
        above?.y !== undefined &&
        line.y !== undefined &&
        above.text.length > 0 &&
        line.text.length > 0
      ) {
        const pitch = Math.round((above.y - line.y) * 2) / 2;
        if (pitch > 0) {
          counts.set(pitch, (counts.get(pitch) ?? 0) + 1);
        }
      }
    }
  }
  let pitch: number | undefined;
  let best = 0;
  for (const [candidate, count] of counts) {
    if (count > best) {
      pitch = candidate;
      best = count;
    }
  }
  return pitch;
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
  const copyRun = ({
    bold,
    text,
    footnoteReference,
    superscript,
  }: PlSnRun): PlSnRun => ({
    bold,
    text,
    ...(footnoteReference === undefined ? {} : { footnoteReference }),
    ...(superscript === undefined ? {} : { superscript }),
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
      head.footnoteReference === undefined &&
      previous.superscript === undefined &&
      head.superscript === undefined
    ) {
      previous.text += separator + head.text;
    } else if (head.superscript === undefined) {
      current.push({ text: separator + head.text, bold: head.bold });
    } else {
      // The line break's space stays on the baseline, out of the index.
      if (separator.length > 0) {
        current.push({ text: separator, bold: head.bold });
      }
      current.push(copyRun(head));
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
          .map(({ bold, superscript, text }) => {
            const raised =
              superscript === true
                ? `<sup>${escapeHtml(text)}</sup>`
                : escapeHtml(text);
            return bold ? `<b>${raised}</b>` : raised;
          })
          .join("")}</p>`,
    )
    .join("");

type PdfTextPage = ReturnType<
  ReturnType<PDF["getPages"]>[number]["extractText"]
>;

type PdfTextLine = PdfTextPage["lines"][number];

const extractedLineOf = (
  line: PdfTextLine,
  marks?: readonly LineMark[],
): ExtractedLine => ({
  spans: line.spans,
  text: normalizeSpanText(line.text),
  x: line.bbox.x,
  right: line.bbox.x + line.bbox.width,
  y: line.bbox.y,
  printedX: printedCharactersOf(line).at(0)?.bbox.x,
  ...(marks === undefined || marks.length === 0 ? {} : { marks }),
});

/** The printed (non-whitespace) characters of a line, in order. */
const printedCharactersOf = (line: PdfTextLine) =>
  line.spans
    .flatMap(({ chars }) => chars)
    .filter(({ char }) => char.trim().length > 0);

/**
 * The baseline a line's own type sits on: its body-type characters', or,
 * where it is all small type, its characters'. Read off the characters
 * rather than the boxes, since a box's bottom also moves with the type's
 * descent.
 */
const baselineOf = (line: PdfTextLine, bodySize: number): number => {
  const printed = printedCharactersOf(line);
  const body = printed.filter(
    ({ fontSize }) => fontSize > bodySize * SMALL_TYPE_RATIO,
  );
  return Math.min(
    ...(body.length > 0 ? body : printed).map(({ baseline }) => baseline),
  );
};

/**
 * The page's lines with every line of small digits folded into the line it
 * is printed over.
 *
 * The text layer gives a raised small-type index its own line, read before
 * the line it belongs to: `art. 394¹ § 1¹` arrives as `1 1` above
 * `art. 394 § 1`. A line counts as one only when it is all digits in small
 * type, sits within a body line's height above the next line, and every
 * mark lies over that line; each mark then follows the characters printed
 * left of it. Anything else stays the line it was.
 *
 * A mark is a superscript on the same evidence as one the text layer kept
 * inside its line: its baseline raised by `SUPERSCRIPT_RAISE_RATIO` of the
 * body size at least, and no number's next group (`10 000`). Otherwise its
 * digits are the line's own text, set back where they are printed.
 */
const liftSuperscripts = (
  lines: readonly PdfTextLine[],
  bodySize: number,
  /** Also read superscripts the text layer kept inside their line. */
  inlineMarks = false,
): ExtractedLine[] => {
  const smallType = (line: PdfTextLine): boolean =>
    printedCharactersOf(line).every(
      ({ fontSize }) => fontSize <= bodySize * SMALL_TYPE_RATIO,
    );
  const marksOver = (
    raised: PdfTextLine,
    base: PdfTextLine | undefined,
  ): LineMark[] | undefined => {
    const characters = printedCharactersOf(raised);
    if (
      base === undefined ||
      characters.length === 0 ||
      !/^[\p{N}\s]+$/u.test(raised.text) ||
      !smallType(raised) ||
      smallType(base)
    ) {
      return undefined;
    }
    const raise = baselineOf(raised, bodySize) - baselineOf(base, bodySize);
    if (
      raise <= 0 ||
      raise >= bodySize ||
      // An index after the line's last word starts past its box; one body
      // size of room keeps `art. 398⁹` at a line's end over its line.
      characters.some(
        ({ bbox }) =>
          bbox.x < base.bbox.x ||
          bbox.x > base.bbox.x + base.bbox.width + bodySize,
      )
    ) {
      return undefined;
    }
    // Adjacent digits are one index (`10`); a gap starts the next mark.
    const groups: (typeof characters)[] = [];
    for (const character of characters) {
      const group = groups.at(-1);
      const previous = group?.at(-1);
      if (
        group !== undefined &&
        previous !== undefined &&
        character.bbox.x - (previous.bbox.x + previous.bbox.width) <
          previous.bbox.width / 2
      ) {
        group.push(character);
      } else {
        groups.push([character]);
      }
    }
    const printed = printedCharactersOf(base);
    const raisedEnough = raise >= bodySize * SUPERSCRIPT_RAISE_RATIO;
    return groups.map((group): LineMark => {
      const x = group.at(0)?.bbox.x ?? 0;
      const after = printed.filter(
        ({ bbox }) => bbox.x + bbox.width / 2 < x,
      ).length;
      const text = group.map(({ char }) => char).join("");
      const previous = printed.at(after - 1);
      const gap =
        previous === undefined || after === 0
          ? Number.POSITIVE_INFINITY
          : x - (previous.bbox.x + previous.bbox.width);
      // A number's next group follows it within a space's width.
      const nextGroup =
        previous !== undefined &&
        gap <= bodySize / 2 &&
        continuesNumber(previous.char, text);
      return raisedEnough && !nextGroup
        ? { type: "superscript", after, text }
        : {
            type: "on-line",
            after,
            text,
            spaced:
              Number.isFinite(gap) && gap >= (previous?.bbox.width ?? 0) / 2,
          };
    });
  };

  const out: ExtractedLine[] = [];
  let pending: LineMark[] = [];
  for (const [index, line] of lines.entries()) {
    const marks = marksOver(line, lines[index + 1]);
    if (marks !== undefined) {
      pending.push(...marks);
      continue;
    }
    if (inlineMarks) {
      const inline = withoutInlineMarks(line, bodySize);
      out.push(extractedLineOf(inline.line, [...pending, ...inline.marks]));
    } else {
      out.push(extractedLineOf(line, pending));
    }
    pending = [];
  }
  return out;
};

/**
 * How far above its line's baseline a superscript's baseline sits at least,
 * as a share of the body size, whether the text layer kept it on the line or
 * gave it a line of its own. The text layer keeps a span on its line only
 * within 2pt of the line's baseline, so a superscript raised the usual third
 * of the type gets a line of its own; of what stays, only a span raised most
 * of that way (from 1.8pt over 12pt type) reads as one, where a small digit
 * group set barely higher is still on the line. Measured between baselines,
 * since a box's bottom also moves with the type's descent: a 7pt span's box
 * sits 1pt above a 12pt line's on the same baseline.
 */
const SUPERSCRIPT_RAISE_RATIO = 0.15;

/**
 * Three digits right after a number are its next group (`10 000`), however
 * the typesetter set them, never an index or a reference.
 */
const continuesNumber = (before: string, digits: string): boolean =>
  /^\d{3}$/u.test(digits) && /\d\s*$/u.test(before);

/**
 * A line without the superscripts the text layer kept on it, and those
 * superscripts as marks: a span of digits alone, set in small type, its
 * baseline raised well above the line's body-type characters (`Tekst¹`),
 * that does not carry on a number before it. The text loses only the marks,
 * each found from where the span before it ended, so equal digits earlier in
 * the line stay.
 */
const withoutInlineMarks = (
  line: PdfTextLine,
  bodySize: number,
): { line: PdfTextLine; marks: SuperscriptMark[] } => {
  const body = printedCharactersOf(line).filter(
    ({ fontSize }) => fontSize > bodySize * SMALL_TYPE_RATIO,
  );
  if (body.length === 0) {
    return { line, marks: [] };
  }
  const baseline = Math.min(...body.map((character) => character.baseline));
  const raisedSmall = ({
    chars,
    fontSize,
    text,
  }: PdfTextLine["spans"][number]) =>
    /^\d{1,3}$/u.test(text.trim()) &&
    fontSize <= bodySize * SMALL_TYPE_RATIO &&
    chars.every(
      (character) =>
        character.char.trim().length === 0 ||
        character.baseline - baseline >= bodySize * SUPERSCRIPT_RAISE_RATIO,
    );
  if (!line.spans.some(raisedSmall)) {
    return { line, marks: [] };
  }
  const marks: SuperscriptMark[] = [];
  const kept: PdfTextLine["spans"] = [];
  let text = "";
  let cursor = 0;
  let printed = 0;
  for (const span of line.spans) {
    const at = line.text.indexOf(span.text, cursor);
    if (at === -1) {
      return { line, marks: [] };
    }
    text += line.text.slice(cursor, at);
    if (
      raisedSmall(span) &&
      !continuesNumber(line.text.slice(0, at), span.text.trim())
    ) {
      marks.push({
        type: "superscript",
        after: printed,
        text: span.text.trim(),
      });
    } else {
      kept.push(span);
      text += span.text;
      printed += span.text.replace(/\s/gu, "").length;
    }
    cursor = at + span.text.length;
  }
  text += line.text.slice(cursor);
  return marks.length === 0
    ? { line, marks }
    : { line: { ...line, spans: kept, text }, marks };
};

/** Every line of every page, in reading order. */
export const extractPlSnLines = async (
  pdfBytes: Uint8Array,
  paragraphStart: PlPdfParagraphStart = PL_PDF_PARAGRAPH_START.INDENT,
  options: ExtractPlSnLinesOptions = {},
): Promise<PlSnLine[]> => {
  const pdf = await PDF.load(pdfBytes);
  const textPages = pdf.getPages().map((page) => page.extractText());
  const { supremeCourt } = options;
  if (supremeCourt === undefined) {
    return textPages.flatMap(({ lines }) =>
      readPage(
        lines.map((line) => extractedLineOf(line)),
        paragraphStart,
      ),
    );
  }

  const pages = textPages.map(({ height, lines }, pageIndex) => {
    const first = lines.findIndex(({ text }) => text.trim().length > 0);
    const header = lines[first];
    // A header is the page's first line, printed in its top margin: the same
    // number opening the body further down is text.
    return pageIndex > 0 &&
      header !== undefined &&
      height - header.bbox.y <= height * RUNNING_HEADER_ZONE_RATIO &&
      isRunningHeader(
        normalizeSpanText(header.text),
        supremeCourt.docket,
        pageIndex + 1,
      )
      ? lines.toSpliced(first, 1)
      : lines;
  });
  return readSetPages(textPages, pages, paragraphStart, SUPREME_COURT_READING)
    .body;
};

export type PlPdfSeparatedContent = {
  body: PlSnLine[];
  notes: PlSnLine[];
};

/** How a publisher's set pages are read, past their furniture. */
type SetPageReading = {
  /** Read each page's footnotes out of its text, not where they are printed. */
  readonly separateNotes: boolean;
  /** Open a paragraph where a line sits further below the one above. */
  readonly paragraphSpacing: boolean;
  /**
   * Measure a line's indent from its first printed character, so an indent
   * typed as spaces is one.
   */
  readonly printedIndent: boolean;
  /** Read superscripts the text layer kept inside their line, too. */
  readonly inlineMarks: boolean;
  readonly markers: PointMarkers;
};

const SUPREME_COURT_READING: SetPageReading = {
  separateNotes: false,
  paragraphSpacing: false,
  printedIndent: false,
  inlineMarks: false,
  markers: POINT_MARKERS,
};

const LETTERHEAD_READING: SetPageReading = {
  separateNotes: true,
  paragraphSpacing: true,
  printedIndent: true,
  inlineMarks: true,
  markers: NUMBERED_PARAGRAPH_MARKERS,
};

/**
 * How far into the page from its top or bottom edge a letterhead, a footer or
 * a page number sits. The furthest observed, a three-line footer, reaches 11%
 * up the page; the body's first and last lines start further in.
 */
const EDGE_ZONE_RATIO = 0.15;

/** How far apart the same footer may sit on two pages and still be one. */
const SAME_PLACE_PT = 2;

/** `3`, `- 3 -`, `3/16`, `Strona 3 z 16`, `str. 3`: page 3's own number. */
const isPageNumber = (text: string, pageNumber: number): boolean => {
  const match =
    /^(?:(?:strona|str\.)\s*)?[-–—]?\s*(?<page>\d{1,4})\s*[-–—]?(?:\s*(?:z|\/)\s*\d{1,4})?$/iu.exec(
      text.replace(/\s+/gu, " ").trim(),
    );
  return match?.groups?.["page"] === String(pageNumber);
};

/**
 * On how many of a document's pages a letterhead line has to sit at the same
 * place to be one: most of them. Never fewer than two, since one page states
 * no repetition.
 */
const LETTERHEAD_PAGE_SHARE = 0.6;

/**
 * How far right of the page's left edge, as a share of its width, a page
 * number's middle sits at least: centred, or set toward the outer margin. A
 * list point's or a table cell's number sits at the body's left margin.
 */
const PAGE_NUMBER_MIDDLE_RATIO = 0.35;

/**
 * How much larger than the body a page number may be set: a point over it
 * (12pt under 11pt) is seen, a heading is set larger.
 */
const PAGE_NUMBER_TYPE_RATIO = 1.15;

/** Whether every printed character of a line is set in small type. */
const setSmall = (line: PdfTextLine, bodySize: number): boolean => {
  const printed = printedCharactersOf(line);
  return (
    printed.length > 0 &&
    printed.every(({ fontSize }) => fontSize <= bodySize * SMALL_TYPE_RATIO)
  );
};

/**
 * Each page's lines without what the publisher prints around the text: its
 * letterhead or footer, and the page's own number.
 *
 * A letterhead line has to show it is one. It sits in a page's top or bottom
 * edge zone, is set in small type, and repeats at the same height on most
 * pages; its digits are left out of the comparison only because a footer
 * carries the page's number. Text in the body's own type is never taken for
 * letterhead, however often it recurs, so a heading or a sentence that comes
 * back at the same place on several pages stays. A footer whose two lines
 * the text layer read as one on some page (`gdansk@uokik.gov.pl
 * www.uokik.gov.pl 2 ul. Podwale`) is still the footer: every piece of it is
 * a repeated small-type line.
 *
 * A page number is the page's own number alone or in its usual wording
 * (`3`, `- 3 -`, `3/16`, `Strona 3 z 16`), printed as the page's first or
 * last line once the letterhead is gone, centred or toward the margin, in
 * type no larger than the body's. It sits at least the body's line spacing
 * away from every other line, or, closer but still clear of the type, at the
 * height another page prints its own number. A footnote's number has the
 * note's text below or beside it, a list point's or a table cell's sits at
 * the body's left margin, and a centred cell sits within the line spacing of
 * its row, so none reads as one. A line is never judged by where it sits
 * against the footer, because a page number printed down the margin sits
 * beside the text, not below it.
 */
const withoutRepeatedFurniture = (
  pages: readonly PdfTextPage[],
  bodySize: number,
): PdfTextLine[][] => {
  const inEdgeZone = (line: PdfTextLine, height: number): boolean =>
    line.bbox.y < height * EDGE_ZONE_RATIO ||
    line.bbox.y > height * (1 - EDGE_ZONE_RATIO);
  // A footer's text with its page number left out, so every page's copy reads
  // the same.
  const keyOf = (line: PdfTextLine): string =>
    normalizeSpanText(line.text)
      .replace(/\d+/gu, "#")
      .replace(/\s+/gu, " ")
      .trim();
  const letterheadCandidate = (line: PdfTextLine, height: number): boolean =>
    inEdgeZone(line, height) &&
    setSmall(line, bodySize) &&
    /\p{L}/u.test(line.text);
  const placed = new Map<string, { page: number; y: number }[]>();
  for (const [page, { height, lines }] of pages.entries()) {
    for (const line of lines) {
      if (letterheadCandidate(line, height)) {
        const key = keyOf(line);
        const places = placed.get(key) ?? [];
        places.push({ page, y: line.bbox.y });
        placed.set(key, places);
      }
    }
  }
  const repeatedOn = Math.max(
    2,
    Math.ceil(pages.length * LETTERHEAD_PAGE_SHARE),
  );
  const repeatedAt = (key: string, at: number): boolean =>
    new Set(
      (placed.get(key) ?? [])
        .filter(({ y }) => Math.abs(y - at) <= SAME_PLACE_PT)
        .map(({ page }) => page),
    ).size >= repeatedOn;
  // Longest first, so a piece is taken whole before a shorter one inside it.
  const repeatedKeys = [...placed]
    .filter(([key, places]) => places.some(({ y }) => repeatedAt(key, y)))
    .map(([key]) => key)
    .toSorted((left, right) => right.length - left.length);
  const isMergedFooter = (key: string): boolean => {
    let rest = key;
    let pieces = 0;
    for (const repeated of repeatedKeys) {
      pieces += rest.split(repeated).length - 1;
      rest = rest.replaceAll(repeated, " ");
    }
    return pieces >= 2 && rest.trim().length === 0;
  };

  const keptPages = pages.map(({ height, lines }) =>
    lines.filter((line) => {
      if (!letterheadCandidate(line, height)) {
        return true;
      }
      const key = keyOf(line);
      return !(repeatedAt(key, line.bbox.y) || isMergedFooter(key));
    }),
  );
  const linePitch =
    linePitchOf(
      keptPages.map((lines) => lines.map((line) => extractedLineOf(line))),
    ) ?? bodySize;

  // Each page's own number as printed, with how far it sits from the
  // nearest other line, before deciding how far is far enough.
  const numbers = pages.map(({ height, width }, page) => {
    const printedLines = (keptPages[page] ?? []).filter(
      (line) => printedCharactersOf(line).length > 0,
    );
    const byHeight = printedLines.toSorted(
      (left, right) => left.bbox.y - right.bbox.y,
    );
    return [byHeight.at(0), byHeight.at(-1)].flatMap((line) => {
      if (line === undefined) {
        return [];
      }
      const printed = printedCharactersOf(line);
      const left = printed.at(0)?.bbox.x ?? 0;
      const lastCharacter = printed.at(-1);
      const right =
        lastCharacter === undefined
          ? left
          : lastCharacter.bbox.x + lastCharacter.bbox.width;
      return inEdgeZone(line, height) &&
        (left + right) / 2 >= width * PAGE_NUMBER_MIDDLE_RATIO &&
        printed.every(
          ({ fontSize }) => fontSize <= bodySize * PAGE_NUMBER_TYPE_RATIO,
        ) &&
        isPageNumber(normalizeSpanText(line.text), page + 1)
        ? [
            {
              line,
              gap: Math.min(
                ...printedLines
                  .filter((other) => other !== line)
                  .map((other) => Math.abs(other.bbox.y - line.bbox.y)),
              ),
            },
          ]
        : [];
    });
  });
  // Set apart from the text by a body line: a raised reference or index sits
  // within a line's height of the line it belongs to, and a table's cell
  // within the body's line spacing of the row above. A number printed closer
  // than the line spacing, though still clear of the type, is the page's
  // number only where another page prints its own at the same height.
  const clear = numbers.map((candidates) =>
    candidates.filter(({ gap }) => gap >= bodySize),
  );
  const numberedAtSamePlace = (page: number, line: PdfTextLine): boolean =>
    clear.some(
      (candidates, other) =>
        other !== page &&
        candidates.some(
          (candidate) =>
            Math.abs(candidate.line.bbox.y - line.bbox.y) <= SAME_PLACE_PT,
        ),
    );
  return keptPages.map((lines, page) => {
    const pageNumbers = new Set(
      (clear[page] ?? [])
        .filter(
          ({ gap, line }) =>
            gap >= linePitch || numberedAtSamePlace(page, line),
        )
        .map(({ line }) => line),
    );
    return lines.filter((line) => !pageNumbers.has(line));
  });
};

/**
 * How much smaller than the body a footnote is set. Notes are set a point or
 * two below the body (10pt under 11pt), where a superscript is set far
 * smaller still.
 */
const NOTE_TYPE_RATIO = 0.95;

const printedSpansOf = (line: ExtractedLine): readonly PdfSpan[] =>
  line.spans.filter(({ text }) => text.trim().length > 0);

type NoteOpening = {
  readonly label: string;
  readonly runs: PlSnRun[];
  /** The size the number is set in, where the text layer kept it a span. */
  readonly labelSize?: number | undefined;
};

/**
 * The number a footnote opens with, and the note's runs without it: a line
 * of the number alone in small type, the number raised over the note's
 * first word, or the number set in small type before it on the same line.
 */
const noteOpeningOf = (
  line: ExtractedLine,
  bodySize: number,
): NoteOpening | undefined => {
  const [first] = printedSpansOf(line);
  const leading = line.marks?.at(0);
  if (leading?.type === "superscript" && leading.after === 0) {
    return /^\d{1,3}$/u.test(leading.text)
      ? {
          label: leading.text,
          runs: runsOfLine({ ...line, marks: line.marks?.slice(1) }),
        }
      : undefined;
  }
  if (
    first === undefined ||
    first.fontSize > bodySize * SMALL_TYPE_RATIO ||
    !/^\d{1,3}$/u.test(first.text.trim())
  ) {
    return undefined;
  }
  const label = first.text.trim();
  const runs = runsOfLine(line);
  const [head, ...tail] = runs;
  if (head === undefined) {
    return undefined;
  }
  const rest = head.text.trimStart().slice(label.length).trimStart();
  return {
    label,
    runs: rest.length === 0 ? tail : [{ ...head, text: rest }, ...tail],
    labelSize: first.fontSize,
  };
};

type PageNotes = {
  /** The page's lines down to its first footnote. */
  readonly body: readonly ExtractedLine[];
  /** Each note's opening and the lines it runs on to. */
  readonly notes: readonly (NoteOpening & {
    readonly lines: readonly ExtractedLine[];
  })[];
};

/**
 * A unit an exponent follows (`m²`, `km³`), so its raised digit is no note's
 * reference.
 */
const EXPONENT_UNIT = /(?:^|[^\p{L}])(?:mm|cm|dm|m|km|ha)$/u;

/**
 * The superscripts of a line, each with whether it reads as a footnote's
 * reference on its own. One after a word or a mark does; one after a unit
 * (`m²`) or a digit can as well be an exponent (`10⁶`) or an article's index
 * (`art. 479⁴⁵`) as a reference (`art. 25¹¹`).
 */
const noteReferencesOf = (
  line: ExtractedLine,
): { text: string; plain: boolean }[] =>
  (line.marks ?? []).flatMap(({ after, text, type }) => {
    if (type !== "superscript") {
      return [];
    }
    let printed = 0;
    let end = 0;
    while (end < line.text.length && printed < after) {
      if (/\S/u.test(line.text.charAt(end))) {
        printed += 1;
      }
      end += 1;
    }
    const before = line.text.slice(0, end);
    return [
      {
        text,
        plain: !/\d$/u.test(before) && !EXPONENT_UNIT.test(before),
      },
    ];
  });

/**
 * A page's footnotes, read off the foot of its text: from the first line
 * that opens a note with a number some superscript above it on the page
 * refers to, where that line and every line below it are set smaller than
 * the body. A note's number has to exceed every note's before it, since a
 * decision numbers its notes through. Requiring the reference, its number
 * and the foot of the page together is what keeps a table set in small type,
 * its rows numbered, in the body, also where an exponent above it (`m²`)
 * prints a row's number.
 *
 * A reference that could as well be an exponent or an index (`m²`, `10⁶`,
 * `art. 25¹¹`) counts only for the very next note's number, and only where
 * something besides the number shows a note: another note opened above it on
 * the page, or its number set in the size the notes before it were. Neither
 * kind of reference makes a row of a numbered table a note: a line whose
 * number continues a column of numbered lines above it at the foot, none of
 * them a note, is the next row, however its number matches.
 *
 * A page whose foot opens no such note keeps every line, and so do lines set
 * small above the first note (an evidence citation, or a note carried over
 * from the page before): left in the body they interrupt a paragraph, where
 * a guess would file text under the wrong note.
 */
const pageNotesOf = (
  lines: readonly ExtractedLine[],
  bodySize: number,
  before: NotesRead,
): PageNotes => {
  let start = lines.length;
  while (
    start > 0 &&
    printedSpansOf(lines[start - 1] ?? { spans: [], text: "", x: 0 }).every(
      ({ fontSize }) => fontSize < bodySize * NOTE_TYPE_RATIO,
    )
  ) {
    start -= 1;
  }
  const references = lines.slice(0, start).flatMap(noteReferencesOf);
  let last = before.label;
  let openedOnPage = false;
  const referencedOpening = (line: ExtractedLine) => {
    const opening = noteOpeningOf(line, bodySize);
    if (opening === undefined) {
      return undefined;
    }
    const label = Number(opening.label);
    const referred = references.filter(({ text }) => text === opening.label);
    if (label <= last || referred.length === 0) {
      return undefined;
    }
    if (referred.some(({ plain }) => plain)) {
      return opening;
    }
    const setAsNotes =
      openedOnPage ||
      (before.labelSize !== undefined &&
        opening.labelSize !== undefined &&
        Math.abs(opening.labelSize - before.labelSize) <= SAME_NOTE_TYPE_PT);
    return label === last + 1 && setAsNotes ? opening : undefined;
  };
  // Lines above the first note open none, so any numbered one in the same
  // column is a row the candidate continues.
  const continuesNumberedColumn = (line: ExtractedLine, index: number) =>
    lines
      .slice(start, index)
      .some(
        (above) =>
          Math.abs(above.x - line.x) <= SAME_PLACE_PT &&
          noteOpeningOf(above, bodySize) !== undefined,
      );
  const first = lines.findIndex(
    (line, index) =>
      index >= start &&
      referencedOpening(line) !== undefined &&
      !continuesNumberedColumn(line, index),
  );
  if (first === -1) {
    return { body: lines, notes: [] };
  }
  const notes: (NoteOpening & { lines: ExtractedLine[] })[] = [];
  for (const line of lines.slice(first)) {
    const opening = referencedOpening(line);
    if (opening !== undefined) {
      last = Number(opening.label);
      openedOnPage = true;
      notes.push({ ...opening, lines: [] });
    } else if (line.text.length > 0) {
      notes.at(-1)?.lines.push(line);
    }
  }
  return { body: lines.slice(0, first), notes };
};

/** What the notes read before a page state about the next one. */
type NotesRead = {
  /** The number of the last note read. */
  readonly label: number;
  /** The size the last note whose number is a span of its own set it in. */
  readonly labelSize?: number | undefined;
};

/**
 * How far apart two notes' numbers may be set and still be in the notes'
 * size: a decision sets some notes half a point apart (6pt and 6.5pt).
 */
const SAME_NOTE_TYPE_PT = 0.5;

/**
 * Lines of set pages, their furniture already dropped, read as the body and,
 * where asked for, the footnotes printed at each page's foot.
 *
 * - superscripts are set back into the line they are printed over;
 * - empty lines at a page's edges, and empty lines set in small type, end no
 *   paragraph: the first set off a header or footer, the second are spacing
 *   marks left inside running text;
 * - an indented block keeps its lines in one paragraph: a line continues the
 *   one above it when that line ran out of room for this line's first word
 *   and this line sits no deeper than it;
 * - where the reading asks, a line set further below the one above than the
 *   document's lines usually are opens a paragraph, and each footnote becomes
 *   a paragraph of its own, labelled with its number and kept out of the
 *   body, so a note printed at a page's foot never interrupts a paragraph
 *   that runs on to the next page.
 */
const readSetPages = (
  textPages: readonly PdfTextPage[],
  pages: readonly (readonly PdfTextLine[])[],
  paragraphStart: PlPdfParagraphStart,
  reading: SetPageReading,
): PlPdfSeparatedContent => {
  const bodySize = bodyFontSizeOf(textPages.flatMap(({ lines }) => lines));
  const notes: PlSnLine[] = [];
  let read: NotesRead = { label: 0 };

  const bodyPages = pages.map((pageLines) => {
    const lifted = liftSuperscripts(
      pageLines,
      bodySize,
      reading.inlineMarks,
    ).map((line) =>
      reading.printedIndent && line.printedX !== undefined
        ? { ...line, x: line.printedX }
        : line,
    );
    let lines: readonly ExtractedLine[] = lifted;
    if (reading.separateNotes) {
      const page = pageNotesOf(lifted, bodySize, read);
      lines = page.body;
      for (const note of page.notes) {
        // Note numbers only rise, so each names one note.
        read = {
          label: Number(note.label),
          labelSize: note.labelSize ?? read.labelSize,
        };
        const footnote = {
          label: note.label,
          noteId: `footnote-${note.label}`,
        };
        notes.push(
          { type: "text", runs: note.runs, indented: true, footnote },
          ...note.lines.map((line): PlSnLine => ({
            type: "text",
            runs: runsOfLine(line),
            indented: false,
            footnote,
          })),
        );
      }
    }
    const start = lines.findIndex(({ text }) => text.length > 0);
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
  const linePitch = reading.paragraphSpacing
    ? linePitchOf(bodyPages)
    : undefined;
  const body = bodyPages.flatMap((lines, pageIndex) =>
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
            linePitch,
            markers: reading.markers,
          },
    ),
  );
  return { body, notes };
};

/**
 * The body and the footnotes of a decision an authority sets on letterhead:
 * a footer or letterhead repeated on every page, and the page's own number,
 * are dropped (`withoutRepeatedFurniture`); the rest is read as
 * `readSetPages` describes. Each note's first line is marked indented, so
 * `assemblePlSnParagraphs` reads every note as a paragraph of its own.
 */
export const extractPlPdfLetterheadContent = async (
  pdfBytes: Uint8Array,
  paragraphStart: PlPdfParagraphStart,
): Promise<PlPdfSeparatedContent> => {
  const pdf = await PDF.load(pdfBytes);
  const textPages = pdf.getPages().map((page) => page.extractText());
  return readSetPages(
    textPages,
    withoutRepeatedFurniture(
      textPages,
      bodyFontSizeOf(textPages.flatMap(({ lines }) => lines)),
    ),
    paragraphStart,
    LETTERHEAD_READING,
  );
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
    superscripts: true,
    // sn.pl indexes neither, so there is nothing to carry onto the AST.
    keywords: [],
    statutes: [],
    documentId: input.documentId,
    sourceSystem: PL_SN_SOURCE_SYSTEM,
  });
};
