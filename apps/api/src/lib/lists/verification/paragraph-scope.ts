/**
 * A verification limited to a range of a document's paragraphs.
 *
 * A paragraph number is the one the document prints: a witness statement
 * numbers its paragraphs (`82.`, `82)`, `[82]`, or Word's automatic list
 * label) and a lawyer cites those. Whether a document's markers are its
 * numbering, and which marker is which paragraph, is read by the one reader
 * of printed paragraph numbers (`extractCourtParagraphNumbers`), over
 * paragraphs rebuilt from the lines by the one printed-line reader
 * (`readPdfLineJoins`). A document that numbers no paragraphs is counted by
 * position instead, and the run records which way it counted.
 *
 * A range resolves to the text from the start of paragraph `from` to the
 * start of the next numbered paragraph after `to`, in the coordinates of the
 * whole document, so a claim found inside it anchors where the reader shows
 * it. Only that text is sent for extraction.
 */

import { isHeadingTitleShape } from "@stll/legal-ast/case-law-heading";
import {
  COURT_PARAGRAPH_NUMBERING_LIMITS,
  extractCourtParagraphNumbers,
  opensWithCourtParagraphMarker,
} from "@stll/legal-ast/court-paragraph-numbers";
import type { Block } from "@stll/legal-ast/document-ast";
import {
  LINE_CONTINUATION_SEPARATOR,
  LINE_JOIN,
} from "@stll/legal-ast/line-wrap";
import { readPrintedLabel } from "@stll/legal-ast/printed-paragraph-labels";

import { readPdfLineJoins } from "@/api/lib/legal-search/parsers/hard-wrapped-lines";
import type { PdfPrintedLine } from "@/api/lib/legal-search/parsers/hard-wrapped-lines";
import type {
  ParagraphNumbering,
  VerificationScope,
  VerificationScopeEdge,
} from "@/api/lib/lists/verification/contract";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";

/** An inclusive range of paragraph numbers, as a reviewer asks for it. */
export type ParagraphRange = { from: number; to: number };

export type ParagraphScope = Extract<VerificationScope, { kind: "paragraphs" }>;

/** A point in the blocks a run reads. */
type TextPoint = { blockIndex: number; offset: number };

/** One paragraph as the document lays it out. */
type DocumentParagraph = {
  start: TextPoint;
  end: TextPoint;
  /** Its words as a reader of labels sees them: a DOCX paragraph's shown
   *  label first, a PDF paragraph's lines joined. */
  text: string;
  heading: boolean;
};

type PdfLine = {
  blockIndex: number;
  start: number;
  end: number;
  printed: PdfPrintedLine | null;
};

/** The lines of consecutive PDF pages, with their geometry when the page
 *  gave a box for every line. A blank line is a hard break. */
const pdfLinesOf = (
  blocks: readonly VerificationBlock[],
  blockIndexes: readonly number[],
): PdfLine[] =>
  blockIndexes.flatMap((blockIndex) => {
    const block = blocks[blockIndex];
    if (block === undefined) {
      return [];
    }
    const lines = block.text.split("\n");
    const boxes =
      block.structure?.type === "pdf-lines" &&
      block.structure.boxes?.length === lines.length
        ? block.structure.boxes
        : null;
    let offset = 0;
    return lines.map((text, lineIndex): PdfLine => {
      const start = offset;
      offset += text.length + 1;
      const box = boxes?.[lineIndex];
      const trimmed = text.trimEnd();
      return {
        blockIndex,
        start,
        end: start + text.length,
        printed:
          trimmed.trim() === ""
            ? null
            : {
                text: trimmed,
                ...(box === undefined
                  ? {}
                  : {
                      layout: {
                        x: box.x,
                        y: box.y,
                        width: box.width,
                        height: box.height,
                        pageIndex: blockIndex,
                      },
                    }),
              },
      };
    });
  });

const pdfParagraphs = (
  blocks: readonly VerificationBlock[],
  blockIndexes: readonly number[],
): DocumentParagraph[] => {
  const lines = pdfLinesOf(blocks, blockIndexes);
  const joins = readPdfLineJoins(lines.map((line) => line.printed));
  const paragraphs: DocumentParagraph[] = [];
  let open: DocumentParagraph | null = null;
  for (const [index, line] of lines.entries()) {
    if (line.printed === null) {
      open = null;
      continue;
    }
    const join = joins[index] ?? LINE_JOIN.BREAK;
    const point = { blockIndex: line.blockIndex, offset: line.start };
    const end = { blockIndex: line.blockIndex, offset: line.end };
    if (open === null || join === LINE_JOIN.BREAK) {
      open = { start: point, end, text: line.printed.text, heading: true };
      paragraphs.push(open);
      continue;
    }
    open.end = end;
    open.heading = false;
    open.text += `${LINE_CONTINUATION_SEPARATOR[join]}${line.printed.text}`;
  }
  // A page has no heading styles: a line standing alone, with no label and
  // no sentence in it (a caption, a section title, a running footer), is
  // read as a heading, so a statement's cover block is not taken for
  // unnumbered paragraphs before its numbering starts.
  return paragraphs.map((paragraph) => ({
    ...paragraph,
    heading:
      paragraph.heading &&
      readPrintedLabel(paragraph.text) === null &&
      isHeadingTitleShape(paragraph.text.trim()),
  }));
};

const docxParagraph = (
  block: VerificationBlock,
  blockIndex: number,
): DocumentParagraph => {
  const structure =
    block.structure?.type === "docx-paragraph" ? block.structure : null;
  const label = structure?.label ?? null;
  return {
    start: { blockIndex, offset: 0 },
    end: { blockIndex, offset: block.text.length },
    text:
      label === null || block.text.trimStart().startsWith(label)
        ? block.text
        : `${label} ${block.text}`,
    heading: structure?.heading ?? false,
  };
};

/** The document's paragraphs in reading order: a DOCX block is one, and the
 *  lines of a run of PDF pages are read back into paragraphs. */
const documentParagraphs = (
  blocks: readonly VerificationBlock[],
): DocumentParagraph[] => {
  const paragraphs: DocumentParagraph[] = [];
  let pdfRun: number[] = [];
  const flushPdf = () => {
    paragraphs.push(...pdfParagraphs(blocks, pdfRun));
    pdfRun = [];
  };
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.source.type === "pdf-page") {
      pdfRun.push(blockIndex);
      continue;
    }
    flushPdf();
    paragraphs.push(docxParagraph(block, blockIndex));
  }
  flushPdf();
  return paragraphs;
};

const astBlockOf = (paragraph: DocumentParagraph, index: number): Block => {
  const id = `p-${String(index)}`;
  const inlines = [{ type: "text" as const, text: paragraph.text }];
  return paragraph.heading
    ? {
        type: "heading",
        id,
        anchorId: id,
        level: 2,
        inlines,
        plainText: paragraph.text,
      }
    : {
        type: "paragraph",
        id,
        anchorId: id,
        inlines,
        plainText: paragraph.text,
      };
};

/** One numbered (or counted) paragraph: its number and where it starts. */
type CountedParagraph = { number: number; index: number };

type ParagraphCount =
  | {
      numbering: ParagraphNumbering;
      paragraphs: readonly DocumentParagraph[];
      /** Every paragraph that carries a number, in reading order. */
      counted: readonly CountedParagraph[];
    }
  | {
      /** Paragraphs open with numbers, but they do not read as one
       *  numbering (a damaged text layer, a numbering that starts midway):
       *  counting by position would silently name other paragraphs. */
      numbering: "unclear";
    };

/** How the document counts its paragraphs, read once. */
export const countParagraphs = (
  blocks: readonly VerificationBlock[],
): ParagraphCount => {
  const paragraphs = documentParagraphs(blocks);
  const numbering = extractCourtParagraphNumbers(
    paragraphs.map((paragraph, index) => astBlockOf(paragraph, index)),
  );
  if (numbering.type === "numbered") {
    return {
      numbering: "document",
      paragraphs,
      counted: numbering.blocks.flatMap((block, index) =>
        block.type === "paragraph" && block.number !== undefined
          ? [{ number: block.number, index }]
          : [],
      ),
    };
  }
  const body = paragraphs.filter((paragraph) => !paragraph.heading);
  if (
    body.filter((paragraph) => opensWithCourtParagraphMarker(paragraph.text))
      .length >= COURT_PARAGRAPH_NUMBERING_LIMITS.minParagraphs.dot
  ) {
    return { numbering: "unclear" };
  }
  const counted: CountedParagraph[] = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    if (!paragraph.heading) {
      counted.push({ number: counted.length + 1, index });
    }
  }
  return { numbering: "ordinal", paragraphs, counted };
};

/** Why a range does not resolve: its first or last paragraph is not in the
 *  document (with the numbers the document does have), or it holds no
 *  text. Either way the run is refused, never widened to the whole
 *  document. */
export type ParagraphScopeRefusal =
  | {
      type: "not-found";
      numbering: ParagraphNumbering;
      missing: readonly number[];
      /** The lowest and highest number the document has; null when none. */
      available: ParagraphRange | null;
    }
  | { type: "empty"; numbering: ParagraphNumbering }
  | { type: "numbering-unclear" };

export type ParagraphScopeResolution =
  { type: "resolved"; scope: ParagraphScope } | ParagraphScopeRefusal;

const edgeOf = (
  blocks: readonly VerificationBlock[],
  point: TextPoint,
): VerificationScopeEdge => ({
  blockId: blocks[point.blockIndex]?.id ?? "",
  offset: point.offset,
});

const availableRange = (
  counted: readonly CountedParagraph[],
): ParagraphRange | null => {
  if (counted.length === 0) {
    return null;
  }
  const numbers = counted.map(({ number }) => number);
  return { from: Math.min(...numbers), to: Math.max(...numbers) };
};

const comesBefore = (a: TextPoint, b: TextPoint): boolean =>
  a.blockIndex < b.blockIndex ||
  (a.blockIndex === b.blockIndex && a.offset < b.offset);

/** The text a scope keeps of each block it touches, in reading order. */
export type VerificationPassage = {
  block: VerificationBlock;
  /** Offsets into the block's own text: the slice the run reads. */
  start: number;
  end: number;
};

/** Every block, whole: what a run over the whole document reads. */
export const wholeDocumentPassages = (
  blocks: readonly VerificationBlock[],
): VerificationPassage[] =>
  blocks.map((block) => ({ block, start: 0, end: block.text.length }));

const passagesBetween = (
  blocks: readonly VerificationBlock[],
  start: TextPoint,
  end: TextPoint,
): VerificationPassage[] =>
  blocks.flatMap((block, blockIndex) => {
    if (blockIndex < start.blockIndex || blockIndex > end.blockIndex) {
      return [];
    }
    const from = blockIndex === start.blockIndex ? start.offset : 0;
    const to = blockIndex === end.blockIndex ? end.offset : block.text.length;
    return to > from ? [{ block, start: from, end: to }] : [];
  });

/**
 * Resolve an inclusive paragraph range against the document. A number the
 * document prints more than once is read at its first place, as
 * `resolveDecisionParagraphRange` reads a court's.
 */
export const resolveParagraphScope = (
  blocks: readonly VerificationBlock[],
  { from, to }: ParagraphRange,
): ParagraphScopeResolution => {
  const count = countParagraphs(blocks);
  if (count.numbering === "unclear") {
    return { type: "numbering-unclear" };
  }
  const { numbering, paragraphs, counted } = count;
  const fromPosition = counted.findIndex(({ number }) => number === from);
  const toPosition =
    fromPosition === -1
      ? -1
      : counted.findIndex(
          ({ number }, position) => position >= fromPosition && number === to,
        );
  if (fromPosition === -1 || toPosition === -1) {
    // Without `from`, `to` is missing too when nothing prints it; with it,
    // `to` printed only before `from` cannot close the range.
    const toMissing =
      fromPosition === -1
        ? to !== from && !counted.some(({ number }) => number === to)
        : true;
    return {
      type: "not-found",
      numbering,
      missing: [
        ...(fromPosition === -1 ? [from] : []),
        ...(toMissing ? [to] : []),
      ],
      available: availableRange(counted),
    };
  }
  const lastIndex = counted[toPosition]?.index ?? -1;
  // The range closes where the next paragraph's section begins: before the
  // headings that open it, after any unnumbered text of `to` itself.
  let nextIndex = counted[toPosition + 1]?.index ?? paragraphs.length;
  while (
    nextIndex - 1 > lastIndex &&
    paragraphs[nextIndex - 1]?.heading === true
  ) {
    nextIndex -= 1;
  }
  const lastBlockIndex = blocks.length - 1;
  const documentEnd: TextPoint = {
    blockIndex: lastBlockIndex,
    offset: blocks[lastBlockIndex]?.text.length ?? 0,
  };
  const start = paragraphs[counted[fromPosition]?.index ?? -1]?.start;
  const end = paragraphs[nextIndex]?.start ?? documentEnd;
  if (start === undefined || !comesBefore(start, end)) {
    return { type: "empty", numbering };
  }
  const passages = passagesBetween(blocks, start, end);
  if (
    passages.every(
      ({ block, start: sliceStart, end: sliceEnd }) =>
        block.text.slice(sliceStart, sliceEnd).trim() === "",
    )
  ) {
    return { type: "empty", numbering };
  }
  return {
    type: "resolved",
    scope: {
      kind: "paragraphs",
      from,
      to,
      numbering,
      start: edgeOf(blocks, start),
      end: edgeOf(blocks, end),
    },
  };
};

/**
 * The text a run reads under its scope: every block whole, or the slices of
 * the blocks a paragraph range spans. Null when a stored range no longer
 * lands in the blocks read (a reader that now splits the document
 * differently): the run then fails rather than read more than was asked.
 */
export const scopePassages = (
  blocks: readonly VerificationBlock[],
  scope: VerificationScope,
): VerificationPassage[] | null => {
  if (scope.kind === "whole") {
    return wholeDocumentPassages(blocks);
  }
  const pointOf = (edge: VerificationScopeEdge): TextPoint | null => {
    const blockIndex = blocks.findIndex((block) => block.id === edge.blockId);
    const block = blocks[blockIndex];
    return block === undefined ||
      !Number.isSafeInteger(edge.offset) ||
      edge.offset < 0 ||
      edge.offset > block.text.length
      ? null
      : { blockIndex, offset: edge.offset };
  };
  const start = pointOf(scope.start);
  const end = pointOf(scope.end);
  if (start === null || end === null || !comesBefore(start, end)) {
    return null;
  }
  return passagesBetween(blocks, start, end);
};

/** The length, in UTF-8 bytes, of the text a set of passages holds: what a
 *  scoped run is sized by before it starts. */
export const passageBytes = (
  passages: readonly VerificationPassage[],
): number =>
  passages.reduce(
    (total, { block, start, end }) =>
      total + Buffer.byteLength(block.text.slice(start, end), "utf-8"),
    0,
  );
