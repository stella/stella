/**
 * Canonical legal-document AST shared by legal corpus readers and parsers.
 */

import * as v from "valibot";

import { collapseSpacedLetters } from "@stll/text-normalize";

import { inlineSchema } from "./inline.js";
import type { Inline } from "./inline.js";

export type {
  Inline,
  InlineBold,
  InlineItalic,
  InlineLineBreak,
  InlineLink,
  InlinePageAnchor,
  InlineText,
  InlineWithChildren,
} from "./inline.js";
export { hasInlineChildren } from "./inline.js";

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
  /** A passage the decision reproduces from another text (block quotation). */
  | "quote"
  /** The centered party block a published reporter opens with. */
  | "parties"
  /** Other centered reporter front matter: docket line, argument and
   * decision dates. */
  | "front-matter"
  /** Reporter-authored apparatus around the decision: counsel appearances,
   * syllabus, headnotes, the panel line. Not the court's own words —
   * readers may fold it away. */
  | "apparatus"
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

/**
 * Flatten `inlines` into the character sequence a renderer walks: text
 * nodes verbatim, a line break as a single "\n", bold/italic/link
 * children recursed into.
 *
 * This is the *raw* axis. Search highlight ranges, citation anchors and
 * annotation offsets all index it, because it is what a renderer emits
 * character for character. Nothing here may normalize, trim or collapse:
 * one character of drift moves every anchor after it.
 */
export const plainTextOf = (inlines: readonly Inline[]): string => {
  let out = "";
  for (const node of inlines) {
    if (node.type === "text") {
      out += node.text;
    } else if (node.type === "line-break") {
      out += "\n";
    } else if (node.type === "page-anchor") {
      // Zero characters: a page break is typography, and it may fall
      // mid-word — the word must stay whole on this axis.
    } else {
      out += plainTextOf(node.children);
    }
  }
  return out;
};

/**
 * Trailing spaces and tabs before a line break, which carry no meaning
 * in rendered text and would otherwise survive into the search text.
 * The lookbehind anchors the match at the run's first character.
 */
const SPACE_BEFORE_NEWLINE = /(?<![ \t])[ \t]+\n/gu;
const NO_BREAK_SPACE = /\u00a0/gu;

/**
 * `inlines` reduced to the text that feeds search and AI reads: the raw
 * flattening with no-break spaces normalized, spaces before a line break
 * dropped, the ends trimmed, and letter-spaced runs collapsed so a
 * court's "R O Z S U D E K" is findable as "ROZSUDEK".
 *
 * This is deliberately NOT the axis offsets index — see `plainTextOf`.
 * The two are separate because they answer different questions: what a
 * reader sees at position N, versus what a search matches.
 *
 * Every parser and the AST wire format derive `plainText` from this one
 * function, so a stored value is always rebuildable from the `inlines`
 * stored beside it.
 */
export const projectPlainText = (inlines: readonly Inline[]): string =>
  collapseSpacedLetters(
    plainTextOf(inlines)
      .replace(NO_BREAK_SPACE, " ")
      .replace(SPACE_BEFORE_NEWLINE, "\n")
      .trim(),
  );

/**
 * A table cell on the wire, with the rebuildable `plainText` absent.
 */
export type WireTableCell = {
  inlines: Inline[];
  plainText?: string | undefined;
};

/**
 * A block on the wire.
 *
 * Heading and paragraph text, and a table cell's text, are rebuildable
 * from the `inlines` beside them, so they do not travel. A table's own
 * `plainText` spans the whole grid and no single inline run produces it,
 * so that one does.
 */
export type WireBlock =
  | (Omit<HeadingBlock, "plainText"> & { plainText?: string | undefined })
  | (Omit<ParagraphBlock, "plainText"> & { plainText?: string | undefined })
  | (Omit<TableBlock, "rows"> & { rows: WireTableCell[][] });

export type WireDocumentAst = Omit<DocumentAst, "blocks"> & {
  blocks: WireBlock[];
};

const fillBlockPlainText = (block: WireBlock): Block => {
  switch (block.type) {
    case "heading": {
      return {
        ...block,
        plainText: block.plainText ?? projectPlainText(block.inlines),
      };
    }
    case "paragraph": {
      return {
        ...block,
        plainText: block.plainText ?? projectPlainText(block.inlines),
      };
    }
    case "table": {
      return {
        ...block,
        rows: block.rows.map((row) =>
          row.map(({ inlines, plainText }) => ({
            inlines,
            plainText: plainText ?? projectPlainText(inlines),
          })),
        ),
      };
    }
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
};

/**
 * Cell separator within a row, and row separator within a table, for a
 * table block's own `plainText`.
 *
 * A tab rather than a visible delimiter: this string is what the corpus
 * index reads for a table, so a separator that is pure whitespace adds
 * no token of its own to the index.
 */
const TABLE_CELL_SEPARATOR = "\t";
const TABLE_ROW_SEPARATOR = "\n";

/**
 * Every `plainText` recomputed from the `inlines` beside it.
 *
 * Applied once at the ingestion boundary, after text sanitization, which
 * is what makes dropping the rebuildable ones from a response lossless: a
 * stored value is by construction what `projectPlainText` yields, so a
 * reader rebuilds it exactly. Parsers need not agree on a normalization,
 * only on producing correct `inlines`.
 *
 * A table block's own `plainText` is not rebuildable from any single
 * inline run, so it still travels on the wire — but it is derived here
 * all the same, by joining the projected cells. Two reasons it cannot be
 * left as the parser wrote it: the corpus index reads this field for a
 * table, so a letter-spaced heading in a cell has to be collapsed here
 * too or it stops matching; and the cells beside it have just been
 * reprojected, so a parser-built join would describe the text they used
 * to hold.
 */
export const withProjectedPlainText = (ast: DocumentAst): DocumentAst => ({
  ...ast,
  blocks: ast.blocks.map((block): Block => {
    if (block.type === "table") {
      const rows = block.rows.map((row) =>
        row.map(({ inlines }) => ({
          inlines,
          plainText: projectPlainText(inlines),
        })),
      );
      return {
        ...block,
        rows,
        plainText: rows
          .map((row) =>
            row.map((cell) => cell.plainText).join(TABLE_CELL_SEPARATOR),
          )
          .join(TABLE_ROW_SEPARATOR),
      };
    }
    return { ...block, plainText: projectPlainText(block.inlines) };
  }),
});

/**
 * The same AST with every rebuildable `plainText` dropped.
 *
 * Sound only because `projectPlainText` is the single producer of those
 * fields: a reader rebuilds exactly what a parser wrote. `parseDocumentAst`
 * is the other half and refills them, so the parsed `DocumentAst` keeps
 * `plainText` required and no consumer of a parsed AST sees the omission.
 */
export const omitDerivablePlainText = (ast: DocumentAst): WireDocumentAst => ({
  ...ast,
  blocks: ast.blocks.map((block): WireBlock => {
    // Every branch drops `plainText` and keeps the rest of the block by
    // spreading it. Listing the fields to keep instead would silently
    // drop each one added later.
    if (block.type === "heading") {
      const { plainText: _derived, ...rest } = block;
      return rest;
    }
    if (block.type === "paragraph") {
      const { plainText: _derived, ...rest } = block;
      return rest;
    }
    return {
      ...block,
      rows: block.rows.map((row) =>
        row.map(({ plainText: _cellDerived, ...cell }) => cell),
      ),
    };
  }),
});

const inlineArraySchema = v.array(v.lazy(() => inlineSchema));

/**
 * Every field of a block except `plainText`, declared once.
 *
 * The canonical schema and the wire schema are the same entries plus a
 * required or an optional `plainText`. Sharing the entries is what keeps
 * them from drifting: a field added to a block reaches both readers, so
 * it can never be validated on the way in and silently dropped on the
 * way out. `v.object` strips what it does not declare, which is exactly
 * how a duplicated wire schema loses a newly added field.
 */
const headingEntries = {
  id: v.string(),
  anchorId: v.string(),
  type: v.literal("heading"),
  level: v.picklist([1, 2, 3, 4, 5, 6]),
  role: v.optional(v.picklist(["decision-title", "section-heading"])),
  inlines: inlineArraySchema,
};

const paragraphEntries = {
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
      "quote",
      "parties",
      "front-matter",
      "apparatus",
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
};

const tableCellEntries = { inlines: inlineArraySchema };

/** Table fields except `rows`, whose cells differ between the two readers. */
const tableEntries = {
  id: v.string(),
  anchorId: v.string(),
  type: v.literal("table"),
  role: v.optional(v.picklist(["related-proceedings", "metadata-table"])),
  plainText: v.string(),
};

const tableCellSchema: v.GenericSchema<TableCell> = v.object({
  ...tableCellEntries,
  plainText: v.string(),
});

const blockSchema: v.GenericSchema<Block> = v.variant("type", [
  v.object({ ...headingEntries, plainText: v.string() }),
  v.object({ ...paragraphEntries, plainText: v.string() }),
  v.object({ ...tableEntries, rows: v.array(v.array(tableCellSchema)) }),
]);

const wireTableCellSchema: v.GenericSchema<WireTableCell> = v.object({
  ...tableCellEntries,
  plainText: v.optional(v.string()),
});

/** `blockSchema` with the rebuildable `plainText` fields made optional. */
const wireBlockSchema: v.GenericSchema<WireBlock> = v.variant("type", [
  v.object({ ...headingEntries, plainText: v.optional(v.string()) }),
  v.object({ ...paragraphEntries, plainText: v.optional(v.string()) }),
  v.object({ ...tableEntries, rows: v.array(v.array(wireTableCellSchema)) }),
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
  blocks: v.array(wireBlockSchema),
});

/**
 * Persisted version-1 ASTs predate required source and metadata fields.
 * Normalize those sparse historical rows at the storage boundary while
 * keeping the canonical runtime guard sound.
 *
 * A block whose rebuildable `plainText` the sender dropped is refilled
 * here from its `inlines`, so the parsed `DocumentAst` keeps
 * `plainText` required and no consumer of a parsed AST can observe the
 * omission.
 */
export const persistedDocumentAstSchema: v.GenericSchema<unknown, DocumentAst> =
  v.pipe(
    persistedDocumentAstWireSchema,
    v.transform(({ blocks, metadata, source }): DocumentAst => ({
      version: 1,
      source: source ?? emptyDocumentAstSource(),
      metadata: metadata ?? emptyDocumentAstMetadata(),
      blocks: blocks.map(fillBlockPlainText),
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
