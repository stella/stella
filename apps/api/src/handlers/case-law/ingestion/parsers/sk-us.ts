// parser-output-unchanged: Validation reparses the original XHTML before hidden-run normalization; stored parser output remains unchanged.
/**
 * Slovak Constitutional Court document parser (the markup rendering).
 *
 * `POST /o/v1/dms/content` answers with the decision as XHTML, which is the
 * same document the court also serves as a file. The markup is flat: one
 * `<div>`, a run of `<span style="font-size: Npx">` and `<br/>` for every
 * visual line, with no paragraph or heading element anywhere. So the
 * structure has to be read the way a reader reads it: the font size marks
 * the title, the court's own section words mark the parts, and a blank line
 * ends a paragraph.
 *
 * Blank lines are why this parser exists beside the file parser rather than
 * reusing it: in the markup a paragraph break is stated, while in the file
 * it has to be guessed from font and position. Both agree on what the parts
 * are called, which is the vocabulary they share.
 *
 * Redaction. The court anonymizes by painting a run black on black:
 * `<span style="color: #000000; background-color: #000000; …">` over a run
 * of `&nbsp;`. The span carries no words, so nothing is being uncovered
 * here; what it carries is a bar as wide as what it replaced. Dropped
 * rather than kept, because those spaces are not text the decision states,
 * and marked anonymized, because a reader has to see that something stood
 * there.
 */

import * as cheerio from "cheerio";
import { type AnyNode, isTag, isText } from "domhandler";

import { COURT_PARAGRAPH_NUMBERING_LIMITS } from "@stll/legal-ast/court-paragraph-numbers";
// parser-output-unchanged: imports the document AST from its package owner
import type {
  Block,
  DocumentAst,
  HeadingBlock,
  Inline,
} from "@stll/legal-ast/document-ast";
import { withUniqueBlockIdentities } from "@stll/legal-ast/document-ast";
import { normalizeInlineLine } from "@stll/legal-ast/inline-line";
import {
  isSkDecisionTitle,
  isSkHoldingMarker,
  isSkInstructionMarker,
  isSkReasoningMarker,
  isSkStandaloneInstructionMarker,
  SK_CLOSING_RE,
  SK_JUDGE_TITLE_RE,
  skSectionHeading,
} from "@stll/legal-ast/slovak-document-roles";
import type { SkDocumentSection } from "@stll/legal-ast/slovak-document-roles";

import {
  ANONYMIZED_CLASS,
  inlinesToPlainText,
  isExcludedHtmlTag,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { courtParagraphNumbers } from "@/api/lib/legal-search/parsers/court-paragraph-numbers";
import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";

/**
 * What a dropped anonymized run reads as.
 *
 * The same word the file parser puts in place of a redaction gap, so the
 * two renderings of one decision do not describe the court's redactions
 * with two different words.
 */
const SK_US_ANONYMIZED_PLACEHOLDER = "anonymizované";

/** The declaration that paints a run the colour of its own background. */
const HIDDEN_STYLE_PARTS = ["color: #000000", "background-color: #000000"];

const isHiddenStyle = (style: string): boolean => {
  const normalized = style.toLowerCase().replaceAll(/\s+/gu, " ");
  return HIDDEN_STYLE_PARTS.every((part) => normalized.includes(part));
};

/** Font size in points, from the span's own declaration. */
const FONT_SIZE_PATTERN = /font-size:\s*(?<size>\d+(?:\.\d+)?)px/u;

const fontSizeOf = (style: string | undefined): number => {
  const size = FONT_SIZE_PATTERN.exec(style ?? "")?.groups?.["size"];
  return size === undefined ? DEFAULT_FONT_SIZE : Number(size);
};

/** What a span with no declaration of its own is rendered at. */
const DEFAULT_FONT_SIZE = 12;

/** Above this, a run is the decision's title rather than its body. */
const TITLE_FONT_SIZE = 14;

/** One visual line of the document, with the size it was rendered at. */
type MarkupLine = {
  inlines: Inline[];
  text: string;
  fontSize: number;
};

/**
 * Replace every hidden run with the placeholder, in place.
 *
 * Marked with the class the inline walker reads rather than by the walker
 * learning about colours: the walker already carries anonymization down a
 * subtree, and this is the one place that knows how this court hides text.
 */
const markHiddenRuns = ($: cheerio.CheerioAPI): void => {
  $("span").each((_, element) => {
    const span = $(element);
    if (!isHiddenStyle(span.attr("style") ?? "")) {
      return;
    }
    span.addClass(ANONYMIZED_CLASS);
    span.text(SK_US_ANONYMIZED_PLACEHOLDER);
  });
};

/** Split one span's inlines into the lines its `<br/>` elements bound. */
const splitAtLineBreaks = (inlines: readonly Inline[]): Inline[][] => {
  const lines: Inline[][] = [[]];
  for (const inline of inlines) {
    if (inline.type === "line-break") {
      lines.push([]);
      continue;
    }
    lines.at(-1)?.push(inline);
  }
  return lines;
};

/**
 * The document's lines, in order, each carrying its own font size.
 *
 * Spans retain their own font signal while the surrounding DOM is walked
 * too, so content in paragraphs, cells, and bare text nodes is accounted
 * for without reading nested spans twice.
 */
const readMarkupLines = ($: cheerio.CheerioAPI): MarkupLine[] => {
  const lines: MarkupLine[] = [];
  let open: MarkupLine | null = null;

  const close = (): void => {
    if (open !== null) {
      lines.push(open);
      open = null;
    }
  };

  const appendRun = (inlines: readonly Inline[], fontSize: number): void => {
    for (const [index, lineInlines] of splitAtLineBreaks(inlines).entries()) {
      if (index > 0) {
        close();
      }
      const text = inlinesToPlainText(lineInlines);
      if (open === null) {
        open = { inlines: [...lineInlines], text, fontSize };
        continue;
      }
      open.inlines.push(...lineInlines);
      open.text += text;
      open.fontSize = Math.max(open.fontSize, fontSize);
    }
  };

  const visit = (node: cheerio.Cheerio<AnyNode>): void => {
    node.contents().each((_, child) => {
      if (isText(child)) {
        appendRun([{ type: "text", text: child.data }], DEFAULT_FONT_SIZE);
        return;
      }
      if (!isTag(child)) {
        return;
      }
      // A script's source and a stylesheet are markup, never the decision's
      // text, whatever element they sit in.
      if (isExcludedHtmlTag(child.name)) {
        return;
      }
      const element = $(child);
      if (child.name === "br") {
        close();
        return;
      }
      if (child.name === "span") {
        const fontSize = fontSizeOf(element.attr("style"));
        appendRun(
          walkInlines($, element, {
            anonymized: element.hasClass(ANONYMIZED_CLASS),
          }),
          fontSize,
        );
        return;
      }
      // Paragraphs and table cells are meaningful boundaries even when a
      // source omits spans and explicit <br/> elements.
      if (["p", "td", "th", "tr"].includes(child.name)) {
        close();
      }
      visit(element);
      if (["p", "td", "th", "tr"].includes(child.name)) {
        close();
      }
    });
  };

  visit($("body"));
  close();

  // A line's inlines are trimmed with its text, so a paragraph joined from
  // lines reads the same through either: the reader's text, and the text
  // left once a court number is cut off the inlines.
  for (const line of lines) {
    const normalized = normalizeInlineLine(line.inlines);
    line.inlines = normalized.inlines;
    line.text = normalized.plainText;
  }
  return lines;
};

/** A number on a line of its own, which is this court's page footer. */
const PAGE_NUMBER_PATTERN = /^\d{1,4}$/u;

type Section = SkDocumentSection;

const headingBlock = ({
  id,
  anchorId,
  level,
  line,
}: {
  id: string;
  anchorId: string;
  level: HeadingBlock["level"];
  line: MarkupLine;
}): Block => ({
  id,
  anchorId,
  type: "heading",
  level,
  ...(level === 1 ? { role: "decision-title" as const } : {}),
  ...(level === 2 ? { role: "section-heading" as const } : {}),
  inlines: line.inlines,
  plainText: line.text,
});

type ClassifyState = { section: Section; blockCount: number };

/**
 * Group the lines into blocks.
 *
 * A paragraph runs until a blank line, a section marker or the end of the
 * document, which is the court's own layout rather than a guess about
 * where a sentence stops.
 */
const classifyLines = (lines: readonly MarkupLine[]): Block[] => {
  const blocks: Block[] = [];
  const state: ClassifyState = { section: "preamble", blockCount: 0 };
  let paragraph: MarkupLine | null = null;
  let nextCourtNumber = 1;

  const nextId = (): string => `b${blocks.length + 1}`;
  /** The open paragraph's text, read through the closure that owns it. */
  const openParagraphText = (): string | null => paragraph?.text ?? null;

  const flushParagraph = (): void => {
    if (paragraph === null) {
      return;
    }
    const line = paragraph;
    paragraph = null;
    state.blockCount += 1;
    const role = ((): "holding" | "intro" | "closing" | "signature" | null => {
      if (state.section === "closing") {
        return "signature";
      }
      if (state.section === "holding") {
        return "holding";
      }
      return state.section === "preamble" && blocks.length <= 1
        ? "intro"
        : null;
    })();
    blocks.push({
      id: nextId(),
      anchorId: `p${state.blockCount}`,
      type: "paragraph",
      ...(role === null ? {} : { role }),
      inlines: line.inlines,
      plainText: line.text,
    });
  };

  const openParagraph = (line: MarkupLine): void => {
    if (paragraph === null) {
      paragraph = { ...line, inlines: [...line.inlines] };
      return;
    }
    paragraph.inlines.push({ type: "text", text: " " }, ...line.inlines);
    paragraph.text = `${paragraph.text} ${line.text}`;
  };

  const openings = lines.map(({ text }) => openingNumberOf(text));
  for (const [lineIndex, line] of lines.entries()) {
    if (line.text.length === 0) {
      flushParagraph();
      continue;
    }
    if (PAGE_NUMBER_PATTERN.test(line.text)) {
      continue;
    }

    if (
      state.section === "preamble" &&
      (line.fontSize > TITLE_FONT_SIZE || isSkDecisionTitle(line.text))
    ) {
      flushParagraph();
      blocks.push(
        headingBlock({ id: nextId(), anchorId: "h-title", level: 1, line }),
      );
      continue;
    }

    if (isSkHoldingMarker(line.text)) {
      flushParagraph();
      state.section = "holding";
      blocks.push(
        headingBlock({ id: nextId(), anchorId: "h-holding", level: 2, line }),
      );
      continue;
    }

    if (isSkReasoningMarker(line.text)) {
      flushParagraph();
      state.section = "reasoning";
      blocks.push(
        headingBlock({ id: nextId(), anchorId: "h-reasoning", level: 2, line }),
      );
      continue;
    }

    if (isSkInstructionMarker(line.text)) {
      flushParagraph();
      state.section = "instruction";
      if (isSkStandaloneInstructionMarker(line.text)) {
        blocks.push(
          headingBlock({
            id: nextId(),
            anchorId: "h-instruction",
            level: 2,
            line,
          }),
        );
      } else {
        openParagraph(line);
        flushParagraph();
      }
      continue;
    }

    if (state.section === "instruction" && SK_CLOSING_RE.test(line.text)) {
      flushParagraph();
      state.section = "closing";
      state.blockCount += 1;
      blocks.push({
        id: nextId(),
        anchorId: `p${state.blockCount}`,
        type: "paragraph",
        role: "closing",
        inlines: line.inlines,
        plainText: line.text,
      });
      continue;
    }

    if (state.section === "instruction" && SK_JUDGE_TITLE_RE.test(line.text)) {
      flushParagraph();
      state.section = "closing";
      openParagraph(line);
      flushParagraph();
      continue;
    }

    const sectionHeading = skSectionHeading(line.text, state.section);
    if (sectionHeading !== null) {
      flushParagraph();
      blocks.push(
        headingBlock({
          id: nextId(),
          anchorId: `h${blocks.length + 1}`,
          level: sectionHeading.level,
          line,
        }),
      );
      continue;
    }

    // The court's next paragraph number opening a line ends the paragraph
    // before it, because some decisions set no blank line between numbered
    // paragraphs. Only when it is unambiguous: the number is the one that
    // comes next, or a forward skip the numbering itself allows, and stands
    // before a capital (a wrapped "1. februára" is not one); the open
    // paragraph has finished a sentence and is not inside a quotation („…“:
    // a quoted petit numbers its own points); and the court does not print
    // the same number again right after this one's list (then this one is a
    // list item and the later one the court's paragraph).
    const opening =
      state.section === "reasoning" ? openings[lineIndex] : undefined;
    const step =
      opening === undefined ? undefined : opening - (nextCourtNumber - 1);
    if (
      opening !== undefined &&
      step !== undefined &&
      step >= 1 &&
      step <= COURT_PARAGRAPH_NUMBERING_LIMITS.maxJump
    ) {
      const open = openParagraphText();
      if (
        open !== null &&
        SENTENCE_END.test(open) &&
        !insideQuotation(open) &&
        !courtRepeatsAfterList(lines, openings, lineIndex, opening)
      ) {
        flushParagraph();
      }
      if (openParagraphText() === null) {
        nextCourtNumber = opening + 1;
      }
    }
    openParagraph(line);
  }
  flushParagraph();

  return blocks;
};

/** Whether a line ends the reasoning or opens a part of it. */
const endsReasoningPart = (text: string): boolean =>
  isSkHoldingMarker(text) ||
  isSkReasoningMarker(text) ||
  isSkInstructionMarker(text) ||
  skSectionHeading(text, "reasoning") !== null;

/**
 * Whether the line at `from`, opening with `number`, is an item of a list
 * that the court's own paragraph `number` follows.
 *
 * Read the way the list would run: its items count on from `number`
 * (`number + 1`, `number + 2`, …) up to the court's paragraph with the same
 * number, which opens where a paragraph can open — after a finished
 * sentence, outside a „quotation“. The look stops at the first number that
 * continues neither, and at the end of the part of the reasoning: past
 * either, a repeat of `number` is a quotation or a list elsewhere in the
 * decision, and says nothing about this line.
 */
const courtRepeatsAfterList = (
  lines: readonly MarkupLine[],
  openings: readonly (number | undefined)[],
  from: number,
  number: number,
): boolean => {
  let listNext = number + 1;
  let previous = lines[from]?.text ?? "";
  let quoted = quotationDepth(previous);
  for (let index = from + 1; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? "";
    if (text.length === 0 || PAGE_NUMBER_PATTERN.test(text)) {
      continue;
    }
    if (endsReasoningPart(text)) {
      return false;
    }
    const later = openings[index];
    if (later === number) {
      if (quoted <= 0 && SENTENCE_END.test(previous)) {
        return true;
      }
    } else if (later !== undefined) {
      if (later !== listNext) {
        return false;
      }
      listNext += 1;
    }
    quoted += quotationDepth(text);
    previous = text;
  }
  return false;
};

/** A line opening with a court paragraph number and a capitalised word. */
const COURT_PARAGRAPH_OPENING = /^(?<number>\d{1,3})\.\s+\p{Lu}/u;

/** The court paragraph number each line opens with, if any. */
const openingNumberOf = (text: string): number | undefined => {
  const raw = COURT_PARAGRAPH_OPENING.exec(text)?.groups?.["number"];
  return raw === undefined ? undefined : Number(raw);
};

/**
 * The end of a sentence: a full stop, question or exclamation mark, then any
 * closing quotes or brackets, then possibly the page number the court prints
 * at the foot of a page, set apart by at least two spaces. A colon, an
 * abbreviation's number ("ods. 1", "č. 2") or a lettered point ("písm. a)")
 * does not end one.
 */
const SENTENCE_END = /[.!?][“”"»)]*(?:\s{2,}\d{1,4})?\s*$/u;

/** Quotations the text opens („) less those it closes (“). */
const quotationDepth = (text: string): number =>
  text.split("„").length - text.split("“").length;

/** Whether the text has opened a „quotation“ it has not closed. */
const insideQuotation = (text: string): boolean => quotationDepth(text) > 0;

export type ParseSkUsDocumentOptions = {
  /** The XHTML the content endpoint served, base64-decoded. */
  xhtml: string;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  documentUrl: string;
};

export type ParseSkUsDocumentResult = {
  documentAst: DocumentAst;
  fulltext: string;
};

/** The source system this court's markup is served by. */
const SK_US_SOURCE_SYSTEM = "ustavnysud.sk";

export const parseSkUsDocumentXhtml = ({
  xhtml,
  caseNumber,
  ecli,
  court,
  decisionDate,
  decisionType,
  documentUrl,
}: ParseSkUsDocumentOptions): ParseSkUsDocumentResult => {
  const $ = cheerio.load(xhtml);
  markHiddenRuns($);
  // A section marker can recur (a title set over two lines, a second
  // holding), and each takes its section's fixed anchor; the repeat is
  // re-keyed so every block keeps an identity of its own.
  const blocks = withUniqueBlockIdentities(
    courtParagraphNumbers(classifyLines(readMarkupLines($)), {
      parser: "sk-us",
      caseNumber,
      url: documentUrl,
    }),
  );

  validateAndLog(
    {
      parser: "sk-us",
      caseNumber,
      url: documentUrl,
    },
    xhtml,
    blocks,
  );

  const fulltext = blocks
    .map(({ plainText }) => plainText)
    .filter((text) => text.length > 0)
    .join("\n\n");

  return {
    documentAst: {
      version: 1,
      source: {
        system: SK_US_SOURCE_SYSTEM,
        documentId: caseNumber,
        webUrl: documentUrl,
        printUrl: "",
      },
      metadata: {
        caseNumber,
        ecli: ecli ?? null,
        court,
        decisionDate: decisionDate ?? null,
        decisionType: decisionType ?? null,
        keywords: [],
        statutes: [],
      },
      blocks,
    },
    fulltext,
  };
};
