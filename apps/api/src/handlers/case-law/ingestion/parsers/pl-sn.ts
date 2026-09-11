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

import { collapseSpacedLetters } from "@stll/text-normalize";

import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import {
  buildBoldRanges,
  normalizeSpanText,
} from "@/api/lib/legal-search/parsers/libpdf-utils";
import type { PdfSpan } from "@/api/lib/legal-search/parsers/libpdf-utils";

/** Publisher recorded on the AST, so a stored document names where it came from. */
const PL_SN_SOURCE_SYSTEM = "sn.pl";

/** A run of characters sharing one font weight. */
export type PlSnRun = { text: string; bold: boolean };

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

/** Read one page's lines, keeping blanks and the indent decision. */
const readPage = (lines: readonly ExtractedLine[]): PlSnLine[] => {
  const margin = bodyMarginOf(
    lines.filter(({ text }) => text.length > 0).map(({ x }) => x),
  );
  return lines.map((line) =>
    line.text.length === 0
      ? { type: "blank" as const }
      : {
          type: "text" as const,
          runs: runsOfLine(line),
          indented: line.x - margin >= INDENT_THRESHOLD_PT,
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
export const assemblePlSnParagraphs = (
  lines: readonly PlSnLine[],
): PlSnRun[][] => {
  const paragraphs: PlSnRun[][] = [];
  let current: PlSnRun[] | undefined;

  // Copied rather than shared: joining a broken word rewrites the run it
  // lands in, and the lines handed in are the caller's to keep.
  const copyRun = ({ bold, text }: PlSnRun): PlSnRun => ({ bold, text });

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
    if (previous.bold === head.bold) {
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
const extractPlSnLines = async (pdfBytes: Uint8Array): Promise<PlSnLine[]> => {
  const pdf = await PDF.load(pdfBytes);
  return pdf.getPages().flatMap((page) => {
    const { lines } = page.extractText();
    return readPage(
      lines.map((line) => ({
        spans: line.spans,
        text: normalizeSpanText(line.text),
        x: line.bbox.x,
      })),
    );
  });
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
    await extractPlSnLines(input.pdfBytes),
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
