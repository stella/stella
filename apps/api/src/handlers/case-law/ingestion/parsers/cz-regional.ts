/**
 * Czech Regional Courts parser.
 *
 * Converts the structured JSON from rozhodnuti.justice.cz
 * /api/finaldoc/{uuid} into a canonical DocumentAst.
 *
 * The API provides pre-segmented sections:
 *   header[]        — intro paragraphs (court, parties)
 *   verdict[]       — ruling items
 *   justification[] — reasoning paragraphs
 *   information[]   — poučení paragraphs
 *
 * Each section entry has:
 *   texts[]: { text, anonStyle } — inline spans
 *   styleLocalId: number — references styles[]
 *
 * styles[]: { localId, alignment, bold, italic, ... }
 */

import { opensWithCourtParagraphMarker } from "@stll/legal-ast/court-paragraph-numbers";
import {
  CZ_CLOSING_RE as CLOSING_RE,
  CZ_JUDGE_TITLE_RE as SIGNATURE_RE,
} from "@stll/legal-ast/czech-document-roles";
// parser-output-unchanged: imports the document AST from its package owner
// parser-output-unchanged: The output is typed as a decision document AST; the emitted AST is unchanged.
import type {
  Block,
  DecisionDocumentAst,
  Inline,
} from "@stll/legal-ast/document-ast";

import { courtParagraphNumbers } from "@/api/lib/legal-search/parsers/court-paragraph-numbers";
import {
  continuesAcrossPageBreak,
  isRunningHeaderLine,
  withoutSoftHyphens,
} from "@/api/lib/legal-search/parsers/page-furniture";
import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/lib/legal-search/parsers/validate-ast";

// ── Types for the finaldoc JSON ────────────────────────────

type TextSpan = {
  text: string;
  anonStyle: string;
};

type FinaldocParagraph = {
  texts: TextSpan[];
  styleLocalId: number;
  tableCellInfo: unknown;
};

type FinaldocStyle = {
  localId: number;
  alignment: string;
  hasSpaceBefore: boolean;
  hasSpaceAfter: boolean;
  bold: boolean;
  italic: boolean;
};

// ── Public API ─────────────────────────────────────────────

export type ParseRegionalInput = {
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
  /** Structured sections from finaldoc JSON. */
  header: FinaldocParagraph[];
  verdict: FinaldocParagraph[];
  justification: FinaldocParagraph[];
  information: FinaldocParagraph[];
  styles: FinaldocStyle[];
  /** Plain text fallbacks (for fulltext + validation). */
  verdictText: string;
  justificationText: string;
};

type ParseRegionalOutput = {
  documentAst: DecisionDocumentAst;
  fulltext: string;
};

export const parseRegionalDecision = (
  input: ParseRegionalInput,
): ParseRegionalOutput => {
  let blockCounter = 0;
  const makeBlockId = (): string => {
    blockCounter += 1;
    return `b${blockCounter}`;
  };
  const styleMap = new Map(input.styles.map((s) => [s.localId, s]));

  const sectionContent = (
    paragraphs: FinaldocParagraph[],
    fallbackText: string,
  ) => {
    const content = withoutPageFurniture(
      paragraphs
        .map((para) => toInlines(para, styleMap))
        .filter(({ plainText }) => plainText.length > 0),
    );
    if (content.length > 0 || !fallbackText.trim()) {
      return content;
    }
    return withoutPageFurniture(
      fallbackText
        .split(/\r?\n/u)
        .map((plainText) => ({
          inlines: textInline(plainText),
          plainText: plainText.trim(),
        }))
        .filter(({ plainText }) => plainText.length > 0),
    );
  };
  const header = sectionContent(input.header, "");
  const verdict = sectionContent(input.verdict, input.verdictText);
  const justification = sectionContent(
    input.justification,
    input.justificationText,
  );
  const information = sectionContent(input.information, "");

  const blocks: Block[] = [];
  let blockIndex = 0;

  // ── Decision type heading (synthesized from metadata) ──
  // Keyed on the local-language type the adapter maps the publisher's enum
  // to, never on the enum: `ORDER_T` is the publisher's criminal order and
  // reaches here as "trestní příkaz".
  const titleMap: Record<string, string> = {
    rozsudek: "ROZSUDEK",
    usnesení: "USNESENÍ",
    "trestní příkaz": "TRESTNÍ PŘÍKAZ",
  };
  // The court's own title line, where the header prints one, is the title;
  // a synthesized one beside it would print the title twice.
  const title = header.some(({ plainText }) => isDecisionTypeTitle(plainText))
    ? undefined
    : titleMap[input.decisionType ?? ""];
  if (title) {
    blockIndex += 1;
    blocks.push({
      id: makeBlockId(),
      anchorId: `h-${blockIndex}`,
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: textInline(title),
      plainText: title,
    });
  }

  // ── Header (intro) ───────────────────────────────────
  for (const { inlines, plainText } of header) {
    blockIndex += 1;
    blocks.push(
      isDecisionTypeTitle(plainText) ||
        compactTitle(plainText) === IN_THE_NAME_OF_THE_REPUBLIC
        ? {
            id: makeBlockId(),
            anchorId: `h-${blockIndex}`,
            type: "heading",
            level: 1,
            role: "decision-title",
            inlines,
            plainText,
          }
        : {
            id: makeBlockId(),
            anchorId: `p-${blockIndex}`,
            type: "paragraph",
            role: "intro",
            inlines,
            plainText,
          },
    );
  }

  // ── Verdict (ruling items) ───────────────────────────
  if (verdict.length > 0) {
    blockIndex += 1;
    blocks.push({
      id: makeBlockId(),
      anchorId: `h-${blockIndex}`,
      type: "heading",
      level: 2,
      role: "section-heading",
      inlines: textInline("takto:"),
      plainText: "takto:",
    });

    for (const { inlines, plainText } of verdict) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: `p-${blockIndex}`,
        type: "paragraph",
        role: "holding",
        inlines,
        plainText,
      });
    }
  }

  // ── Justification ────────────────────────────────────
  if (justification.length > 0) {
    blockIndex += 1;
    blocks.push({
      id: makeBlockId(),
      anchorId: `h-${blockIndex}`,
      type: "heading",
      level: 2,
      role: "section-heading",
      inlines: textInline("Odůvodnění:"),
      plainText: "Odůvodnění:",
    });

    for (const { inlines, plainText } of justification) {
      blockIndex += 1;
      const block = classifyJustificationParagraph(
        inlines,
        plainText,
        blockIndex,
        makeBlockId,
      );
      blocks.push(block);
    }
  }

  // ── Information (poučení) ────────────────────────────
  if (input.information.length > 0) {
    blockIndex += 1;
    blocks.push({
      id: makeBlockId(),
      anchorId: `h-${blockIndex}`,
      type: "heading",
      level: 2,
      role: "section-heading",
      inlines: textInline("Poučení:"),
      plainText: "Poučení:",
    });

    for (const { inlines, plainText } of information) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: `p-${blockIndex}`,
        type: "paragraph",
        inlines,
        plainText,
      });
    }
  }

  const numbered = courtParagraphNumbers(blocks, {
    parser: "cz-regional",
    caseNumber: input.caseNumber,
    url: input.sourceUrl,
  });
  const fulltext = numbered
    .flatMap((b) => (b.plainText ? [b.plainText] : []))
    .join("\n\n");

  const validationHtml = buildValidationHtml([
    ...input.header.map((para) => toInlines(para, styleMap).plainText),
    ...verdict.map(({ plainText }) => plainText),
    ...justification.map(({ plainText }) => plainText),
    ...input.information.map((para) => toInlines(para, styleMap).plainText),
  ]);
  validateAndLog(
    { parser: "cz-regional", caseNumber: input.caseNumber },
    validationHtml,
    numbered,
  );

  const ast: DecisionDocumentAst = {
    version: 1,
    source: {
      system: "justice.cz",
      documentId: input.caseNumber,
      webUrl: input.sourceUrl ?? "",
      printUrl: "",
    },
    metadata: {
      caseNumber: input.caseNumber,
      ecli: input.ecli ?? null,
      court: input.court,
      decisionDate: input.decisionDate ?? null,
      decisionType: input.decisionType ?? null,
      keywords: [],
      statutes: [],
    },
    blocks: numbered,
  };

  return { documentAst: ast, fulltext };
};

// ── Helpers ────────────────────────────────────────────────

const textInline = (text: string): Inline[] => [{ type: "text", text }];

/** The decision types a header prints as its title line. */
const DECISION_TYPE_TITLES = [
  "ROZSUDEK",
  "USNESENÍ",
  "TRESTNÍ PŘÍKAZ",
  "PLATEBNÍ ROZKAZ",
  "ELEKTRONICKÝ PLATEBNÍ ROZKAZ",
  "EVROPSKÝ PLATEBNÍ ROZKAZ",
  "SMĚNEČNÝ PLATEBNÍ ROZKAZ",
  "ŠEKOVÝ PLATEBNÍ ROZKAZ",
] as const;

/** A title line's letters, whatever the spacing: "R O Z S U D E K". */
const compactTitle = (text: string): string =>
  text.toLocaleUpperCase("cs-CZ").replace(/\s+/gu, "");

const COMPACT_DECISION_TYPE_TITLES: ReadonlySet<string> = new Set(
  DECISION_TYPE_TITLES.map(compactTitle),
);

const IN_THE_NAME_OF_THE_REPUBLIC = compactTitle("JMÉNEM REPUBLIKY");

const isDecisionTypeTitle = (text: string): boolean =>
  COMPACT_DECISION_TYPE_TITLES.has(compactTitle(text));

type SectionParagraph = { inlines: Inline[]; plainText: string };

/**
 * A section's paragraphs without the running headers ("pokračování -3- sp.
 * zn. 9 C 191/2025") the publisher keeps where a page broke, and with the
 * sentence the page break cut read as one paragraph again.
 */
const withoutPageFurniture = (
  paragraphs: readonly SectionParagraph[],
): SectionParagraph[] => {
  const kept: SectionParagraph[] = [];
  let afterPageBreak = false;
  for (const paragraph of paragraphs) {
    if (isRunningHeaderLine(paragraph.plainText)) {
      afterPageBreak = true;
      continue;
    }
    const previous = kept.at(-1);
    if (
      afterPageBreak &&
      previous !== undefined &&
      continuesAcrossPageBreak(previous.plainText, paragraph.plainText)
    ) {
      previous.inlines.push({ type: "text", text: " " }, ...paragraph.inlines);
      previous.plainText = `${previous.plainText} ${paragraph.plainText}`;
    } else {
      kept.push(paragraph);
    }
    afterPageBreak = false;
  }
  return kept;
};

const OPENING_QUOTE = "„";
const SPACE_RE = /^[ \t ]$/u;
const VISIBLE_RE = /^\S$/u;
/** What a quotation may open right after, with no space between. */
const OPENS_BEFORE_QUOTE_RE = /^[\s([{/]$/u;

/**
 * The paragraph's span texts as the court printed them.
 *
 * The publisher's conversion moves the space before an opening quotation
 * mark inside it ("nazvané„ Dálnice", "(„ oprava“)"). Czech typography never
 * spaces the inside of a quotation, so the space goes back before the mark,
 * or away where the mark follows a bracket or opens the paragraph. The repair
 * reads the paragraph's whole text, because the mark and the word it quotes
 * can sit in different spans ("též„ " before an anonymised name), and each
 * character stays in the span it came from.
 */
type SpanTextRun = { text: string; span: TextSpan };

const spanTexts = (spans: readonly TextSpan[]): SpanTextRun[] => {
  const chars = spans.flatMap((span) =>
    Array.from(withoutSoftHyphens(span.text), (char) => ({ char, span })),
  );
  for (let index = 0; index < chars.length; index++) {
    const quote = chars[index];
    const space = chars[index + 1];
    if (
      quote?.char !== OPENING_QUOTE ||
      space === undefined ||
      !SPACE_RE.test(space.char) ||
      !VISIBLE_RE.test(chars[index + 2]?.char ?? "")
    ) {
      continue;
    }
    const before = chars[index - 1]?.char;
    if (before === undefined || OPENS_BEFORE_QUOTE_RE.test(before)) {
      chars.splice(index + 1, 1);
      continue;
    }
    chars[index] = space;
    chars[index + 1] = quote;
    index += 1;
  }
  const runs: SpanTextRun[] = [];
  for (const { char, span } of chars) {
    const previous = runs.at(-1);
    if (previous?.span === span) {
      previous.text += char;
    } else {
      runs.push({ text: char, span });
    }
  }
  return runs;
};

/** Convert a finaldoc paragraph to Inline nodes. */
const toInlines = (
  para: FinaldocParagraph,
  styleMap: Map<number, FinaldocStyle>,
): { inlines: Inline[]; plainText: string } => {
  const style = styleMap.get(para.styleLocalId);
  const inlines: Inline[] = [];
  let plain = "";
  const texts = spanTexts(para.texts);

  for (const { text, span } of texts) {
    if (!text) {
      continue;
    }
    plain += text;

    const isAnon = span.anonStyle === "ANON";
    const node: Inline = isAnon
      ? { type: "text", text, anonymized: true }
      : { type: "text", text };

    if (style?.bold && style.italic) {
      inlines.push({
        type: "bold",
        children: [{ type: "italic", children: [node] }],
      });
    } else if (style?.bold) {
      inlines.push({ type: "bold", children: [node] });
    } else if (style?.italic) {
      inlines.push({ type: "italic", children: [node] });
    } else {
      inlines.push(node);
    }
  }

  return { inlines, plainText: plain.trim() };
};

/** Classify a justification paragraph into the right block type. */
const classifyJustificationParagraph = (
  inlines: Inline[],
  plainText: string,
  blockIndex: number,
  makeBlockId: () => string,
): Block => {
  // A numbered paragraph ("1. …") stays whole here: whether its marker is the
  // court's numbering is decided over the whole decision, by
  // `courtParagraphNumbers` once every block is built. It is body text, never
  // a closing or a signature: "3. Věc projednala samosoudkyně …" names the
  // judge but is the court's paragraph 3.
  if (opensWithCourtParagraphMarker(plainText)) {
    return {
      id: makeBlockId(),
      anchorId: `p-${blockIndex}`,
      type: "paragraph",
      inlines,
      plainText,
    };
  }

  // Closing: "V [City] dne [date]"
  if (CLOSING_RE.test(plainText)) {
    return {
      id: makeBlockId(),
      anchorId: `p-${blockIndex}`,
      type: "paragraph",
      role: "closing",
      inlines,
      plainText,
    };
  }

  // Signature
  if (SIGNATURE_RE.test(plainText) && plainText.length < 80) {
    return {
      id: makeBlockId(),
      anchorId: `p-${blockIndex}`,
      type: "paragraph",
      role: "signature",
      inlines,
      plainText,
    };
  }

  // Default
  return {
    id: makeBlockId(),
    anchorId: `p-${blockIndex}`,
    type: "paragraph",
    inlines,
    plainText,
  };
};
