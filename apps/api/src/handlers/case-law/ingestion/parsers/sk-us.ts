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

import {
  isSkDecisionTitle,
  isSkHoldingMarker,
  isSkInstructionMarker,
  isSkReasoningMarker,
  isSkStandaloneInstructionMarker,
  SK_CLOSING_RE,
  SK_JUDGE_TITLE_RE,
  SK_ROMAN_DIVIDER_RE,
} from "@stll/legal-ast/slovak-document-roles";

import type {
  Block,
  DocumentAst,
  Inline,
} from "@/api/handlers/case-law/document-ast";
import {
  ANONYMIZED_CLASS,
  inlinesToPlainText,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";

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
 * Walked span by span rather than over the whole `<div>`: the size is on
 * the span, and a walk of the container would flatten away the one signal
 * that tells a title from a sentence. A line the court splits across two
 * spans is stitched back together, which is how `OPRAVNÉ ` and `UZNESENIE`
 * become one title line.
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

  $("body span").each((_, element) => {
    const span = $(element);
    // Only the outermost span of a run: a nested one is already walked as
    // part of its parent, and walking it again would double its text.
    if (span.parents("span").length > 0) {
      return;
    }
    const fontSize = fontSizeOf(span.attr("style"));
    // Seeded from the span itself: the walker reads the marker class on the
    // elements it descends into, and the run this court hides is the root of
    // the walk rather than something inside it.
    for (const [index, inlines] of splitAtLineBreaks(
      walkInlines($, span, { anonymized: span.hasClass(ANONYMIZED_CLASS) }),
    ).entries()) {
      if (index > 0) {
        close();
      }
      const text = inlinesToPlainText(inlines);
      if (open === null) {
        open = { inlines: [...inlines], text, fontSize };
        continue;
      }
      open.inlines.push(...inlines);
      open.text += text;
      // The larger of the two: a title the court opened in body size and
      // finished in display size is a title line.
      open.fontSize = Math.max(open.fontSize, fontSize);
    }
  });
  close();

  for (const line of lines) {
    line.text = line.text.trim();
  }
  return lines;
};

/** A number on a line of its own, which is this court's page footer. */
const PAGE_NUMBER_PATTERN = /^\d{1,4}$/u;

type Section = "preamble" | "holding" | "reasoning" | "instruction" | "closing";

const headingBlock = ({
  id,
  anchorId,
  level,
  line,
}: {
  id: string;
  anchorId: string;
  level: 1 | 2 | 3;
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

  const nextId = (): string => `b${blocks.length + 1}`;

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

  for (const line of lines) {
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

    if (SK_ROMAN_DIVIDER_RE.test(line.text)) {
      flushParagraph();
      blocks.push(
        headingBlock({
          id: nextId(),
          anchorId: `h${blocks.length + 1}`,
          level: 3,
          line,
        }),
      );
      continue;
    }

    openParagraph(line);
  }
  flushParagraph();

  return blocks;
};

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
  const blocks = classifyLines(readMarkupLines($));

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
