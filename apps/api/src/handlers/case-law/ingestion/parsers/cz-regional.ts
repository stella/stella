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

import {
  CZ_CLOSING_RE as CLOSING_RE,
  CZ_JUDGE_TITLE_RE as SIGNATURE_RE,
} from "@stll/legal-ast/czech-document-roles";
import type { Block, DocumentAst, Inline } from "@stll/legal-ast/document-ast";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";

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
  documentAst: DocumentAst;
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

  const fulltext = blocks
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
    blocks,
  );

  const ast: DocumentAst = {
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
    blocks,
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

const inlinePlainLength = (nodes: readonly Inline[]): number => {
  let len = 0;
  for (const n of nodes) {
    if (n.type === "text") {
      len += n.text.length;
    } else if (hasInlineChildren(n)) {
      len += inlinePlainLength(n.children);
    }
  }
  return len;
};

/** Strip N characters from the front of inlines. */
const stripPrefix = (
  inlines: readonly Inline[],
  charCount: number,
): Inline[] => {
  if (charCount <= 0) {
    return [...inlines];
  }

  const result: Inline[] = [];
  let remaining = charCount;

  for (const node of inlines) {
    if (remaining <= 0) {
      result.push(node);
      continue;
    }
    if (node.type === "text") {
      if (node.text.length <= remaining) {
        remaining -= node.text.length;
      } else {
        const sliced: Inline = {
          type: "text",
          text: node.text.slice(remaining),
          ...(node.anonymized && { anonymized: true }),
        };
        result.push(sliced);
        remaining = 0;
      }
    } else if (
      node.type === "bold" ||
      node.type === "italic" ||
      node.type === "link"
    ) {
      const len = inlinePlainLength(node.children);
      if (len <= remaining) {
        remaining -= len;
      } else {
        const stripped = stripPrefix(node.children, remaining);
        remaining = 0;
        if (stripped.length > 0) {
          result.push({ ...node, children: stripped });
        }
      }
    }
  }

  const first = result[0];
  if (result.length > 0 && first?.type === "text") {
    const trimmed = first.text.trimStart();
    if (trimmed) {
      result[0] = {
        type: "text",
        text: trimmed,
        ...(first.anonymized && { anonymized: true }),
      };
    } else {
      result.shift();
    }
  }

  return result;
};

/** Classify a justification paragraph into the right block type. */
const classifyJustificationParagraph = (
  inlines: Inline[],
  plainText: string,
  blockIndex: number,
  makeBlockId: () => string,
): Block => {
  // Numbered paragraph: "1. ...", "2. ..."
  const numMatch = NUMBERED_PARA_RE.exec(plainText);
  if (numMatch) {
    const text = plainText.slice(numMatch[0].length).trim();
    return {
      id: makeBlockId(),
      anchorId: `p-${blockIndex}`,
      type: "paragraph",
      inlines: stripPrefix(inlines, numMatch[0].length),
      plainText: text,
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

// ── Patterns ───────────────────────────────────────────────

const NUMBERED_PARA_RE = /^(?:\d+)\.\s+/u;
