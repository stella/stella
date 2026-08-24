/**
 * Canonical legal-document AST shared by legal corpus readers and parsers.
 */

import * as v from "valibot";

import { inlineSchema } from "./inline.js";
import type { Inline } from "./inline.js";

export type {
  Inline,
  InlineBold,
  InlineItalic,
  InlineLineBreak,
  InlineLink,
  InlineText,
} from "./inline.js";

/**
 * Heading depth, one to six.
 *
 * A depth a document reaches has to be expressible: a level clamped away
 * turns a real container into a sibling of its parent.
 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type HeadingBlock = {
  id: string;
  anchorId: string;
  type: "heading";
  level: HeadingLevel;
  role?: "decision-title" | "section-heading" | undefined;
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

export type ParagraphNote = {
  type: "footnote";
  label: string;
};

export type ParagraphBlock = {
  id: string;
  anchorId: string;
  type: "paragraph";
  role?: ParagraphRole | undefined;
  /**
   * Publisher-authored note metadata. Kept separate from `role`: notes can
   * occur in any positional section.
   */
  note?: ParagraphNote | undefined;
  /**
   * Paragraph number assigned by the publishing court, when the source
   * numbers its paragraphs (CJEU judgments, opinions and orders do).
   * Citations reference these numbers, so they are kept as structure
   * rather than as a prefix inside `plainText`.
   */
  number?: number | undefined;
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
  role?: "related-proceedings" | "metadata-table" | undefined;
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

const inlineArraySchema = v.array(v.lazy(() => inlineSchema));
const tableCellSchema: v.GenericSchema<TableCell> = v.object({
  inlines: inlineArraySchema,
  plainText: v.string(),
});
const blockSchema: v.GenericSchema<Block> = v.variant("type", [
  v.object({
    id: v.string(),
    anchorId: v.string(),
    type: v.literal("heading"),
    level: v.picklist([1, 2, 3, 4, 5, 6]),
    role: v.optional(v.picklist(["decision-title", "section-heading"])),
    inlines: inlineArraySchema,
    plainText: v.string(),
  }),
  v.object({
    id: v.string(),
    anchorId: v.string(),
    type: v.literal("paragraph"),
    role: v.optional(
      v.picklist([
        "case-number",
        "intro",
        "history",
        "argumentation",
        "holding",
        "closing",
        "signature",
        "unknown",
      ]),
    ),
    note: v.optional(
      v.variant("type", [
        v.object({
          type: v.literal("footnote"),
          label: v.string(),
        }),
      ]),
    ),
    number: v.optional(v.pipe(v.number(), v.finite())),
    inlines: inlineArraySchema,
    plainText: v.string(),
  }),
  v.object({
    id: v.string(),
    anchorId: v.string(),
    type: v.literal("table"),
    role: v.optional(v.picklist(["related-proceedings", "metadata-table"])),
    rows: v.array(v.array(tableCellSchema)),
    plainText: v.string(),
  }),
]);

const documentAstSourceSchema: v.GenericSchema<DocumentAstSource> = v.object({
  system: v.string(),
  documentId: v.string(),
  webUrl: v.string(),
  printUrl: v.string(),
});

const documentAstMetadataSchema: v.GenericSchema<DocumentAstMetadata> =
  v.object({
    caseNumber: v.nullable(v.string()),
    ecli: v.nullable(v.string()),
    court: v.nullable(v.string()),
    decisionDate: v.nullable(v.string()),
    decisionType: v.nullable(v.string()),
    keywords: v.array(v.string()),
    statutes: v.array(v.string()),
  });

export const documentAstSchema: v.GenericSchema<DocumentAst> = v.object({
  version: v.literal(1),
  source: documentAstSourceSchema,
  metadata: documentAstMetadataSchema,
  blocks: v.array(blockSchema),
});

const emptyDocumentAstSource = () =>
  ({
    system: "",
    documentId: "",
    webUrl: "",
    printUrl: "",
  }) satisfies DocumentAstSource;

const emptyDocumentAstMetadata = () =>
  ({
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  }) satisfies DocumentAstMetadata;

const persistedDocumentAstWireSchema = v.object({
  version: v.literal(1),
  source: v.optional(documentAstSourceSchema),
  metadata: v.optional(documentAstMetadataSchema),
  blocks: v.array(blockSchema),
});

/**
 * Persisted version-1 ASTs predate required source and metadata fields.
 * Normalize those sparse historical rows at the storage boundary while
 * keeping the canonical runtime guard sound.
 */
export const persistedDocumentAstSchema: v.GenericSchema<unknown, DocumentAst> =
  v.pipe(
    persistedDocumentAstWireSchema,
    v.transform(({ blocks, metadata, source }): DocumentAst => ({
      version: 1,
      source: source ?? emptyDocumentAstSource(),
      metadata: metadata ?? emptyDocumentAstMetadata(),
      blocks,
    })),
  );

export const isDocumentAst = (val: unknown): val is DocumentAst =>
  v.is(documentAstSchema, val);

export const parseDocumentAst = (raw: unknown): DocumentAst | null => {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      const result = v.safeParse(persistedDocumentAstSchema, parsed);
      return result.success ? result.output : null;
    } catch {
      return null;
    }
  }
  const result = v.safeParse(persistedDocumentAstSchema, raw);
  return result.success ? result.output : null;
};

export const getDocumentAstMetadata = (
  raw: unknown,
): DocumentAstMetadata | null => {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const result = v.safeParse(persistedDocumentAstWireSchema, value);
  return result.success ? (result.output.metadata ?? null) : null;
};

export const parseUsableDocumentAst = (raw: unknown): DocumentAst | null => {
  const ast = parseDocumentAst(raw);
  return ast !== null && ast.blocks.length > 0 ? ast : null;
};

export const hasUsableAst = (val: unknown): val is DocumentAst =>
  isDocumentAst(val) && val.blocks.length > 0;
