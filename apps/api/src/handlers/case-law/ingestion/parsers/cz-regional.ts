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
    const content = paragraphs
      .map((para) => toInlines(para, styleMap))
      .filter(({ plainText }) => plainText.length > 0);
    if (content.length > 0 || !fallbackText.trim()) {
      return content;
    }
    return [
      { inlines: textInline(fallbackText), plainText: fallbackText.trim() },
    ];
  };
  const verdict = sectionContent(input.verdict, input.verdictText);
  const justification = sectionContent(
    input.justification,
    input.justificationText,
  );

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
  const title = titleMap[input.decisionType ?? ""];
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
  for (const para of input.header) {
    const { inlines, plainText } = toInlines(para, styleMap);
    if (!plainText) {
      continue;
    }

    blockIndex += 1;
    blocks.push({
      id: makeBlockId(),
      anchorId: `p-${blockIndex}`,
      type: "paragraph",
      role: "intro",
      inlines,
      plainText,
    });
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

    for (const para of input.information) {
      const { inlines, plainText } = toInlines(para, styleMap);
      if (!plainText) {
        continue;
      }

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

/** Convert a finaldoc paragraph to Inline nodes. */
const toInlines = (
  para: FinaldocParagraph,
  styleMap: Map<number, FinaldocStyle>,
): { inlines: Inline[]; plainText: string } => {
  const style = styleMap.get(para.styleLocalId);
  const inlines: Inline[] = [];
  let plain = "";

  for (const span of para.texts) {
    if (!span.text) {
      continue;
    }
    plain += span.text;

    const isAnon = span.anonStyle === "ANON";
    const node: Inline = isAnon
      ? { type: "text", text: span.text, anonymized: true }
      : { type: "text", text: span.text };

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
