// parser-output-unchanged: [pl-sn] the paragraph helpers moved unchanged to pl-printed-lines.ts; positioned spaces and superscript placement stay as on main.
// parser-output-unchanged: [pl-kis] extracting paragraph helpers leaves the default PDF reader unchanged; it calls readPage without the positioned block metadata those helpers require.
// parser-output-unchanged: [pl-uokik] extracting paragraph helpers leaves the default PDF reader unchanged; it calls readPage without the positioned block metadata those helpers require.
// parser-output-unchanged: [cz-uohs] the helper extraction does not affect extractPlPdfSeparatedContent, which reads through readPagesWithFootnotes and never calls readPage.
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
  INDENT_THRESHOLD_PT,
  opensBlockParagraph,
} from "@/api/handlers/case-law/ingestion/parsers/pl-printed-lines";
import {
  buildFontStyleRanges,
  normalizeSpanText,
} from "@/api/lib/legal-search/parsers/libpdf-utils";
import type { PdfSpan } from "@/api/lib/legal-search/parsers/libpdf-utils";

/** Publisher recorded on the AST, so a stored document names where it came from. */
const PL_SN_SOURCE_SYSTEM = "sn.pl";

/** A run of characters sharing font emphasis. */
export type PlSnRun = {
  text: string;
  bold: boolean;
  italic?: true | undefined;
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
  /** Superscripts the text layer printed as a line of their own above it. */
  readonly superscripts?: readonly SuperscriptMark[] | undefined;
};

/**
 * One superscript, placed by how many of its line's printed characters
 * (whitespace aside) stand before it: counting printed characters survives
 * the spacing the line's text is normalised with.
 */
type SuperscriptMark = { readonly after: number; readonly text: string };

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
   *   sits no deeper than it;
   * - a word space the text layer marks only by a gap between two glyphs,
   *   with no space glyph, is read as a space.
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
  const ranges = buildFontStyleRanges(line.spans, line.text);
  const runs = ranges.flatMap((range) => {
    const text = collapseSpacedLetters(line.text.slice(range.start, range.end));
    return text.length === 0
      ? []
      : [
          {
            text,
            bold: range.bold,
            ...(range.italic ? { italic: true as const } : {}),
          },
        ];
  });
  return line.superscripts === undefined
    ? runs
    : withSuperscripts(runs, line.superscripts);
};

/**
 * The runs with each superscript set in after the printed character it
 * follows. Collapsing letter spacing removes only whitespace, so the count
 * of printed characters still finds the place.
 */
/** Non-space code points in `text`, the unit `withSuperscripts` counts in. */
const printedCodePointsIn = (text: string): number => {
  let count = 0;
  for (const character of text) {
    if (!/\s/u.test(character)) {
      count += 1;
    }
  }
  return count;
};

const withSuperscripts = (
  runs: readonly PlSnRun[],
  marks: readonly SuperscriptMark[],
): PlSnRun[] => {
  const pending = marks.toSorted((left, right) => left.after - right.after);
  const out: PlSnRun[] = [];
  let printed = 0;
  const setDue = (run: PlSnRun | undefined): void => {
    while (pending.length > 0 && (pending.at(0)?.after ?? 0) <= printed) {
      const mark = pending.shift();
      if (mark !== undefined) {
        out.push({
          text: mark.text,
          bold: run?.bold ?? false,
          ...(run?.italic === undefined ? {} : { italic: run.italic }),
          superscript: true,
        });
      }
    }
  };
  for (const run of runs) {
    setDue(run);
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
        setDue(run);
        start = end;
      }
    }
    if (start < run.text.length) {
      out.push({ ...run, text: run.text.slice(start) });
    }
  }
  setDue(runs.at(-1));
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
  const copyRun = ({
    bold,
    italic,
    text,
    footnoteReference,
    superscript,
  }: PlSnRun): PlSnRun => ({
    bold,
    text,
    ...(italic === undefined ? {} : { italic }),
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
      previous.italic === head.italic &&
      previous.footnoteReference === undefined &&
      head.footnoteReference === undefined &&
      previous.superscript === undefined &&
      head.superscript === undefined
    ) {
      previous.text += separator + head.text;
    } else if (head.superscript === undefined) {
      current.push({ ...copyRun(head), text: separator + head.text });
    } else {
      // The line break's space stays on the baseline, out of the index.
      if (separator.length > 0) {
        current.push({
          text: separator,
          bold: head.bold,
          ...(head.italic === undefined ? {} : { italic: head.italic }),
        });
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
          .map(({ bold, italic, superscript, text }) => {
            const raised =
              superscript === true
                ? `<sup>${escapeHtml(text)}</sup>`
                : escapeHtml(text);
            const emphasized = italic === true ? `<i>${raised}</i>` : raised;
            return bold ? `<b>${emphasized}</b>` : emphasized;
          })
          .join("")}</p>`,
    )
    .join("");

type PdfTextLine = ReturnType<
  ReturnType<PDF["getPages"]>[number]["extractText"]
>["lines"][number];

const extractedLineOf = (
  line: PdfTextLine,
  superscripts?: readonly SuperscriptMark[],
): ExtractedLine => ({
  spans: line.spans,
  text: normalizeSpanText(line.text),
  x: line.bbox.x,
  right: line.bbox.x + line.bbox.width,
  ...(superscripts === undefined || superscripts.length === 0
    ? {}
    : { superscripts }),
});

type PdfTextChar = PdfTextLine["spans"][number]["chars"][number];

/**
 * How wide a gap between two glyphs has to be, as a share of the font's own
 * space, to read as a word space the text layer printed no glyph for.
 *
 * Some of this court's PDFs place a word space by position alone, with no
 * space glyph, and the extractor inserts one only past a fixed 0.3 em, wider
 * than the 0.278 em space of the Arial the court sets in. Measured on those
 * PDFs, the letters of one word sit at most 0.05 em apart and such a space
 * leaves 0.16 em or more; two fifths of the space (0.11 em) falls between.
 */
const POSITIONED_SPACE_RATIO = 0.4;

/**
 * A word space's width, in ems, for a document that prints no space glyph to
 * measure: the narrow end of common text faces (Times 0.25 em, Arial
 * 0.278 em).
 */
const TYPOGRAPHIC_SPACE_EM = 0.25;

const SPACE_GLYPH = " ";

/** The most common value, or `undefined` for none. */
const modeOf = (values: readonly number[]): number | undefined => {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let mode: number | undefined;
  let best = 0;
  for (const [value, count] of counts) {
    if (count > best) {
      mode = value;
      best = count;
    }
  }
  return mode;
};

/**
 * A space's width per font, in ems, and the width for a font that prints no
 * space.
 */
type SpaceWidths = {
  readonly byFont: ReadonlyMap<string, number>;
  readonly fallback: number;
};

/**
 * Whether the glyph was read off the content stream. The extractor numbers
 * each glyph it reads in stream order and places a space it inserts itself
 * half a step after the glyph before it, so only a printed glyph carries a
 * whole number.
 */
const isPrinted = ({ sequenceIndex }: PdfTextChar): boolean =>
  sequenceIndex !== undefined && Number.isInteger(sequenceIndex);

/**
 * Each font's space width, read off the space glyphs the document prints:
 * the most common width per font, and across the document for a font that
 * prints none. A space the extractor inserted is left out, since it spans
 * whatever gap it filled rather than a space's width. A document that prints
 * no space at all is measured against a typographic word space.
 */
const spaceWidthsOf = (lines: readonly PdfTextLine[]): SpaceWidths => {
  const widths = new Map<string, number[]>();
  for (const { spans } of lines) {
    for (const { chars } of spans) {
      for (const char of chars) {
        const { bbox, fontName, fontSize } = char;
        if (char.char !== SPACE_GLYPH || !isPrinted(char) || fontSize <= 0) {
          continue;
        }
        const em = Math.round((bbox.width / fontSize) * 1000) / 1000;
        const ems = widths.get(fontName);
        if (ems === undefined) {
          widths.set(fontName, [em]);
        } else {
          ems.push(em);
        }
      }
    }
  }
  const fallback = modeOf([...widths.values()].flat()) ?? TYPOGRAPHIC_SPACE_EM;
  const byFont = new Map<string, number>();
  for (const [fontName, ems] of widths) {
    byFont.set(fontName, modeOf(ems) ?? fallback);
  }
  return { byFont, fallback };
};

const gapBetween = (left: PdfTextChar, right: PdfTextChar): number =>
  right.bbox.x - (left.bbox.x + left.bbox.width);

const printsInk = ({ char }: PdfTextChar): boolean => char.trim().length > 0;

/**
 * The letter spacing after each glyph of a line, in points.
 *
 * It is read per run: the glyphs of one span (one font and size) between two
 * spaces, which share whatever character spacing they were set with. A run
 * is letter-spaced by the narrowest gap between its glyphs: about zero
 * inside a word, and the tracking of a letter-spaced token (`2-9` set with
 * character spacing), where every glyph stands the same gap from the next.
 * That takes two gaps at least, so a run of two glyphs, whose one gap may be
 * a word space, reads as not letter-spaced. A gap to a glyph of another run
 * says nothing about either run's spacing.
 */
const letterSpacingOf = (line: PdfTextLine): number[] => {
  const spacing: number[] = [];
  for (const { chars } of line.spans) {
    let start = spacing.length;
    let gaps: number[] = [];
    let last: PdfTextChar | undefined;
    const close = () => {
      const tracking = gaps.length >= 2 ? Math.max(0, Math.min(...gaps)) : 0;
      spacing.fill(tracking, start);
      gaps = [];
      last = undefined;
    };
    for (const char of chars) {
      if (!printsInk(char)) {
        close();
        spacing.push(0);
        start = spacing.length;
        continue;
      }
      if (last !== undefined) {
        gaps.push(gapBetween(last, char));
      }
      last = char;
      spacing.push(0);
    }
    close();
  }
  return spacing;
};

/**
 * The line with a space set wherever two glyphs stand a word space apart and
 * the text layer printed none between them.
 *
 * A gap is measured past the letter spacing of the glyph before it (see
 * `letterSpacingOf`), so a letter-spaced token is never split letter by
 * letter, and is a word space past two fifths of that font's space. The
 * space joins the span of the glyph before it, as the extractor's own
 * inserted spaces do.
 */
const withPositionedSpaces = (
  line: PdfTextLine,
  spaceWidths: SpaceWidths,
): PdfTextLine => {
  const chars = line.spans.flatMap((span) => span.chars);
  const letterSpacing = letterSpacingOf(line);
  const spaceAfter = (index: number): PdfTextChar | undefined => {
    const previous = chars[index];
    const next = chars[index + 1];
    if (
      previous === undefined ||
      next === undefined ||
      !printsInk(previous) ||
      !printsInk(next)
    ) {
      return undefined;
    }
    const tracking =
      letterSpacing[index] ??
      panic(`No letter spacing was read for glyph ${index} of its line`);
    const gap = gapBetween(previous, next);
    const space =
      spaceWidths.byFont.get(previous.fontName) ?? spaceWidths.fallback;
    const fontSize = (previous.fontSize + next.fontSize) / 2;
    if (gap - tracking <= space * fontSize * POSITIONED_SPACE_RATIO) {
      return undefined;
    }
    return {
      char: SPACE_GLYPH,
      bbox: {
        x: previous.bbox.x + previous.bbox.width,
        y: previous.bbox.y,
        width: gap,
        height: previous.bbox.height,
      },
      fontSize,
      fontName: previous.fontName,
      baseline: (previous.baseline + next.baseline) / 2,
    };
  };

  let inserted = false;
  let index = 0;
  const spans = line.spans.map((span) => ({ ...span }));
  for (const [spanIndex, span] of spans.entries()) {
    const out: PdfTextChar[] = [];
    for (const char of span.chars) {
      const space = spaceAfter(index - 1);
      if (space !== undefined) {
        inserted = true;
        // At a span boundary the space ends the span before, so a bold
        // range never starts with it.
        const before = out.length === 0 ? spans[spanIndex - 1] : undefined;
        if (before === undefined) {
          out.push(space);
        } else {
          before.chars.push(space);
          before.text += SPACE_GLYPH;
        }
      }
      out.push(char);
      index += 1;
    }
    span.chars = out;
    span.text = out.map(({ char: glyph }) => glyph).join("");
  }
  return inserted
    ? { ...line, spans, text: spans.map(({ text }) => text).join("") }
    : line;
};

/** The printed (non-whitespace) characters of a line, in order. */
const printedCharactersOf = (line: PdfTextLine) =>
  line.spans
    .flatMap(({ chars }) => chars)
    .filter(({ char }) => char.trim().length > 0);

/**
 * The page's lines with every superscript line folded into the line it is
 * printed over.
 *
 * The text layer gives a raised small-type index its own line, read before
 * the line it belongs to: `art. 394¹ § 1¹` arrives as `1 1` above
 * `art. 394 § 1`. A line counts as one only when it is all digits in small
 * type, sits within a body line's height above the next line, and every
 * mark lies over that line; each mark then follows the characters printed
 * left of it. Anything else stays the line it was.
 */
const liftSuperscripts = (
  lines: readonly PdfTextLine[],
  bodySize: number,
): ExtractedLine[] => {
  const smallType = (line: PdfTextLine): boolean =>
    printedCharactersOf(line).every(
      ({ fontSize }) => fontSize <= bodySize * SMALL_TYPE_RATIO,
    );
  const marksOver = (
    raised: PdfTextLine,
    base: PdfTextLine | undefined,
  ): SuperscriptMark[] | undefined => {
    const characters = printedCharactersOf(raised);
    if (
      base === undefined ||
      characters.length === 0 ||
      !/^[\p{N}\s]+$/u.test(raised.text) ||
      !smallType(raised) ||
      smallType(base) ||
      raised.bbox.y <= base.bbox.y ||
      raised.bbox.y - base.bbox.y >= bodySize ||
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
    return groups.map((group) => {
      const x = group.at(0)?.bbox.x ?? 0;
      return {
        // Counted in printed code points, as `withSuperscripts` places it: one
        // extracted glyph may carry several (a ligature reads "fi").
        after: printed
          .filter(({ bbox }) => bbox.x + bbox.width / 2 < x)
          .reduce((count, { char }) => count + printedCodePointsIn(char), 0),
        text: group.map(({ char }) => char).join(""),
      };
    });
  };

  const out: ExtractedLine[] = [];
  let pending: SuperscriptMark[] = [];
  for (const [index, line] of lines.entries()) {
    const marks = marksOver(line, lines[index + 1]);
    if (marks !== undefined) {
      pending.push(...marks);
      continue;
    }
    out.push(extractedLineOf(line, pending));
    pending = [];
  }
  return out;
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

  const spaceWidths = spaceWidthsOf(textPages.flatMap(({ lines }) => lines));
  const spacedPages = textPages.map(({ height, lines }) => ({
    height,
    lines: lines.map((line) => withPositionedSpaces(line, spaceWidths)),
  }));
  const bodySize = bodyFontSizeOf(spacedPages.flatMap(({ lines }) => lines));
  const pages = spacedPages.map(({ height, lines }, pageIndex) => {
    const first = lines.findIndex(({ text }) => text.trim().length > 0);
    const header = lines[first];
    // A header is the page's first line, printed in its top margin: the same
    // number opening the body further down is text.
    return liftSuperscripts(
      pageIndex > 0 &&
        header !== undefined &&
        height - header.bbox.y <= height * RUNNING_HEADER_ZONE_RATIO &&
        isRunningHeader(
          normalizeSpanText(header.text),
          supremeCourt.docket,
          pageIndex + 1,
        )
        ? lines.toSpliced(first, 1)
        : lines,
      bodySize,
    );
  });
  const bodyPages = pages.map((lines) => {
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
    superscripts: true,
    // sn.pl indexes neither, so there is nothing to carry onto the AST.
    keywords: [],
    statutes: [],
    documentId: input.documentId,
    sourceSystem: PL_SN_SOURCE_SYSTEM,
  });
};
