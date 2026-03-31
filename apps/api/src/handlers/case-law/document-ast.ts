/**
 * Canonical legal-document AST.
 *
 * Source-specific parsers (e.g. cz_ns) produce this structure
 * from court HTML. The frontend renders from it; AI overlays
 * reference block IDs.
 */

// ── Inline nodes ───────────────────────────────────────────

export type InlineText = {
  type: "text";
  text: string;
  /** True when this text was anonymized by the court. */
  anonymized?: true;
};
export type InlineBold = { type: "bold"; children: Inline[] };
export type InlineItalic = {
  type: "italic";
  children: Inline[];
};
export type InlineLink = {
  type: "link";
  href: string;
  children: Inline[];
};
export type InlineLineBreak = { type: "line-break" };

export type Inline =
  | InlineText
  | InlineBold
  | InlineItalic
  | InlineLink
  | InlineLineBreak;

// ── Block nodes ────────────────────────────────────────────

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

// ── Document root ──────────────────────────────────────────

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

/**
 * Runtime type guard for DocumentAst from jsonb columns.
 * Use this instead of inline `as` casts when narrowing
 * documentAst from Drizzle queries.
 */
export const isDocumentAst = (val: unknown): val is DocumentAst =>
  val !== null &&
  val !== undefined &&
  typeof val === "object" &&
  "version" in val &&
  "blocks" in val &&
  Array.isArray((val as { blocks?: unknown }).blocks);

/**
 * Check if a jsonb value is a DocumentAst with at least
 * one block. Use in read-by-id to decide whether to fetch
 * fulltext fallback.
 */
export const hasUsableAst = (val: unknown): val is DocumentAst =>
  isDocumentAst(val) && val.blocks.length > 0;
