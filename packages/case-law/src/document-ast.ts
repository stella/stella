/**
 * Canonical legal-document AST shared by the case-law API and web viewer.
 */

const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

export type InlineText = {
  type: "text";
  text: string;
  /** True when this text was anonymized by the court. */
  anonymized?: true;
};

export type InlineBold = { type: "bold"; children: Inline[] };
export type InlineItalic = { type: "italic"; children: Inline[] };
export type InlineLink = { type: "link"; href: string; children: Inline[] };
export type InlineLineBreak = { type: "line-break" };

export type Inline =
  | InlineText
  | InlineBold
  | InlineItalic
  | InlineLink
  | InlineLineBreak;

export type HeadingBlock = {
  id: string;
  anchorId: string;
  type: "heading";
  level: 1 | 2 | 3;
  role?: "decision-title" | "section-heading";
  inlines: Inline[];
  plainText: string;
};

export type ParagraphRole =
  | "case-number"
  | "intro"
  | "history"
  | "argumentation"
  | "holding"
  | "closing"
  | "signature"
  | "unknown";

export type ParagraphBlock = {
  id: string;
  anchorId: string;
  type: "paragraph";
  role?: ParagraphRole;
  inlines: Inline[];
  plainText: string;
};

export type TableCell = {
  inlines: Inline[];
  plainText: string;
};

export type TableBlock = {
  id: string;
  anchorId: string;
  type: "table";
  role?: "related-proceedings" | "metadata-table";
  rows: TableCell[][];
  plainText: string;
};

export type Block = HeadingBlock | ParagraphBlock | TableBlock;

export type DocumentAstSource = {
  system: string;
  documentId: string;
  webUrl: string;
  printUrl: string;
};

export type DocumentAstMetadata = {
  caseNumber: string | null;
  ecli: string | null;
  court: string | null;
  decisionDate: string | null;
  decisionType: string | null;
  keywords: string[];
  statutes: string[];
};

export type DocumentAst = {
  version: 1;
  source: DocumentAstSource;
  metadata: DocumentAstMetadata;
  blocks: Block[];
};

export const isDocumentAst = (val: unknown): val is DocumentAst =>
  isRecord(val) && val["version"] === 1 && Array.isArray(val["blocks"]);

export const parseDocumentAst = (raw: unknown): DocumentAst | null => {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isDocumentAst(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isDocumentAst(raw) ? raw : null;
};

export const getDocumentAstMetadata = (
  raw: unknown,
): DocumentAstMetadata | null => parseDocumentAst(raw)?.metadata ?? null;

export const hasUsableAst = (val: unknown): val is DocumentAst =>
  isDocumentAst(val) && val.blocks.length > 0;
