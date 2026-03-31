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

import type {
  Block,
  DocumentAst,
  Inline,
} from "@/api/handlers/case-law/document-ast";
import { validateAndLog } from "@/api/handlers/case-law/ingestion/parsers/validate-ast";

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

export type ParseRegionalOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

export const parseRegionalDecision = (
  input: ParseRegionalInput,
): ParseRegionalOutput => {
  blockCounter = 0;
  const styleMap = new Map(input.styles.map((s) => [s.localId, s]));

  const blocks: Block[] = [];
  let blockIndex = 0;

  // ── Decision type heading (synthesized from metadata) ──
  const titleMap: Record<string, string> = {
    rozsudek: "ROZSUDEK",
    usnesení: "USNESENÍ",
    příkaz: "PŘÍKAZ",
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
  if (input.verdict.length > 0) {
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

    for (const para of input.verdict) {
      const { inlines, plainText } = toInlines(para, styleMap);
      if (!plainText) {
        continue;
      }

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
  if (input.justification.length > 0) {
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

    for (const para of input.justification) {
      const { inlines, plainText } = toInlines(para, styleMap);
      if (!plainText) {
        continue;
      }

      blockIndex += 1;
      const block = classifyJustificationParagraph(
        inlines,
        plainText,
        blockIndex,
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
    .map((b) => b.plainText)
    .filter(Boolean)
    .join("\n\n");

  // Validate with synthetic HTML wrapper
  validateAndLog(
    "cz-regional",
    input.caseNumber,
    `<body><p>${input.verdictText}</p><p>${input.justificationText}</p></body>`,
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

let blockCounter = 0;

const makeBlockId = (): string => {
  blockCounter += 1;
  return `b${blockCounter}`;
};

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

    if (style?.bold && style?.italic) {
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

const inlinePlainLength = (nodes: Inline[]): number => {
  let len = 0;
  for (const n of nodes) {
    if (n.type === "text") {
      len += n.text.length;
    } else if ("children" in n) {
      len += inlinePlainLength(n.children);
    }
  }
  return len;
};

/** Strip N characters from the front of inlines. */
const stripPrefix = (inlines: Inline[], charCount: number): Inline[] => {
  if (charCount <= 0) {
    return inlines;
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
    } else if ("children" in node) {
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
): Block => {
  // Numbered paragraph: "1. ...", "2. ..."
  const numMatch = plainText.match(NUMBERED_PARA_RE);
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

const NUMBERED_PARA_RE = /^(\d+)\.\s+/;

const CLOSING_RE =
  /^(?:V\s+)?\p{Lu}\p{Ll}+\s+(?:dne\s+)?\d{1,2}\.\s*(?:\p{Ll}+\s+)?\d{4}/u;

const SIGNATURE_RE =
  /předsed(?:a|kyně)\s+senátu|samosoudce|samosoudkyně|soudce?\s+zpravodaj|v\.\s*r\.\s*$/i;
