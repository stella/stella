import { panic } from "better-result";
/**
 * Canonical legal-document AST shared by legal corpus readers and parsers.
 *
 * Some structure deliberately does not live here. A quotation running over
 * several paragraphs is several adjacent `quote` paragraphs: adjacency is
 * the grouping, and no wrapper block exists for it. Scan provenance (a
 * page image, bounding boxes per block) is not part of the AST either; if
 * it is ever needed it belongs in a sidecar keyed by block id, so the text
 * axis stays independent of how a document was captured. And `number` is
 * the court's own citable paragraph number and nothing else — editorial
 * numbering and list counters stay inside the text, which is why there is
 * no list block.
 */
import * as v from "valibot";

import { collapseSpacedLetters } from "@stll/text-normalize";

import {
  inlineSchema,
  isKnownInlineType,
  persistedInlineArraySchema,
  rawInlineTypes,
} from "./inline.js";
import type { Inline } from "./inline.js";

export type {
  Inline,
  InlineBold,
  InlineCitation,
  InlineItalic,
  InlineLineBreak,
  InlineLink,
  InlinePageAnchor,
  InlineSubscript,
  InlineSuperscript,
  InlineText,
  InlineUnderline,
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

/**
 * The role sets, one per block type, are the source of truth for the role
 * types, the strict schema a writer validates against, and the tolerant
 * persisted reader. A role added here reaches all three; a role added
 * anywhere else is a type error.
 */
export const HEADING_ROLES = ["decision-title", "section-heading"] as const;

export type HeadingRole = (typeof HEADING_ROLES)[number];

export type HeadingBlock = {
  id: string;
  anchorId: string;
  type: "heading";
  level: HeadingLevel;
  role?: HeadingRole | undefined;
  inlines: Inline[];
  plainText: string;
};

export const PARAGRAPH_ROLES = [
  "case-number",
  "intro",
  "history",
  "argumentation",
  "holding",
  "closing",
  "signature",
  /** A passage the decision reproduces from another text (block quotation). */
  "quote",
  /** The centered party block a published reporter opens with. */
  "parties",
  /** Other centered reporter front matter: docket line, argument and
   * decision dates. */
  "front-matter",
  /** Publisher-authored apparatus around the decision, of a kind the
   * finer roles below do not name. Not the court's own words —
   * readers may fold it away. */
  "apparatus",
  /** The publisher's official summary of the decision, printed with it
   * but not part of it. */
  "syllabus",
  /** Publisher-written points of law drawn from the decision. */
  "headnotes",
  /** Any other publisher abstract of the decision. */
  "summary",
  /** Appearances of counsel and agents. */
  "counsel",
  /** The judges sitting, as a list. */
  "panel",
  /**
   * No role known. Also what a persisted reader assigns to a paragraph
   * whose stored role it does not recognise (see `tolerantRole`).
   */
  "unknown",
] as const;

export type ParagraphRole = (typeof PARAGRAPH_ROLES)[number];

/**
 * The publisher-authored roles a reader may fold away: everything around
 * the decision that the court did not write.
 *
 * `panel` is not one of them. The bench is a fact about the decision that
 * a reader looks for, not apparatus wrapped around it.
 */
export const APPARATUS_ROLES = [
  "apparatus",
  "syllabus",
  "headnotes",
  "summary",
  "counsel",
] as const satisfies readonly ParagraphRole[];

export type ApparatusRole = (typeof APPARATUS_ROLES)[number];

export type ParagraphNote = {
  type: "footnote";
  /** The note's mark as printed ("3", "[3]", "*"). */
  label: string;
  /**
   * Identity of the note this paragraph is part of.
   *
   * A footnote that runs over several paragraphs is several ADJACENT
   * footnote paragraphs sharing one `noteId` and repeating the SAME
   * `label`; a reader shows the label once, on the first, and the return
   * arrow once, on the last. A footnote paragraph with no `noteId` is
   * complete by itself.
   */
  noteId?: string | undefined;
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
  /** Columns this cell spans. Absent when it spans one. */
  colSpan?: number | undefined;
  /** Rows this cell spans. Absent when it spans one. */
  rowSpan?: number | undefined;
  /** A header cell. Absent for a data cell. */
  header?: true | undefined;
};

export const TABLE_ROLES = ["related-proceedings", "metadata-table"] as const;

export type TableRole = (typeof TABLE_ROLES)[number];

export type TableBlock = {
  id: string;
  anchorId: string;
  type: "table";
  role?: TableRole | undefined;
  rows: TableCell[][];
  plainText: string;
};

/**
 * A figure the publisher printed with the document: a seal, a signature
 * scan, a diagram in the reasoning.
 *
 * `src` addresses the image in an asset store and is never the bytes
 * themselves — see `imageSrcSchema`. `plainText` is the alt text, so the
 * one field every text walker reads keeps working over an image without
 * knowing what an image is.
 */
export type ImageBlock = {
  id: string;
  anchorId: string;
  type: "image";
  src: string;
  alt?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  plainText: string;
};

export type Block = HeadingBlock | ParagraphBlock | TableBlock | ImageBlock;

/** The blocks whose text is one inline run. */
export type InlineBlock = Extract<Block, { inlines: Inline[] }>;

/**
 * Whether a block kind carries one inline run, per kind. Total over
 * `Block["type"]`, so a kind added without an entry is a type error
 * rather than a block a text walker silently skips.
 */
const BLOCK_CARRIES_INLINES = {
  heading: true,
  paragraph: true,
  table: false,
  image: false,
} as const satisfies Record<Block["type"], boolean>;

export const hasBlockInlines = (block: Block): block is InlineBlock =>
  BLOCK_CARRIES_INLINES[block.type];

/** The roles each block type may carry; total over `Block["type"]`. */
export const BLOCK_ROLES = {
  heading: HEADING_ROLES,
  paragraph: PARAGRAPH_ROLES,
  table: TABLE_ROLES,
  /** A figure is addressed and sized, never positioned by role. */
  image: [],
} as const satisfies Record<Block["type"], readonly string[]>;

export const isApparatusRole = (
  role: string | undefined,
): role is ApparatusRole =>
  role !== undefined && isMemberOf(APPARATUS_ROLES, role);

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
 * nodes verbatim, a line break as a single "\n", every container's
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
      // A citation's `cite` is zero characters here for the same reason:
      // the printed reference is the children, `cite` is metadata beside
      // them.
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
export type WireTableCell = Omit<TableCell, "plainText"> & {
  plainText?: string | undefined;
};

/**
 * A block on the wire.
 *
 * Heading and paragraph text, a table cell's text, and an image's alt
 * text are rebuildable from the fields beside them, so they do not
 * travel. A table's own `plainText` spans the whole grid and no single
 * inline run produces it, so that one does.
 */
export type WireBlock =
  | (Omit<HeadingBlock, "plainText"> & { plainText?: string | undefined })
  | (Omit<ParagraphBlock, "plainText"> & { plainText?: string | undefined })
  | (Omit<ImageBlock, "plainText"> & { plainText?: string | undefined })
  | (Omit<TableBlock, "rows"> & { rows: WireTableCell[][] });

export type WireDocumentAst = Omit<DocumentAst, "blocks"> & {
  blocks: WireBlock[];
};

/** An image's text axis: its alt text, or nothing when it has none. */
const imagePlainText = (alt: string | undefined): string => alt ?? "";

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
    case "image": {
      return {
        ...block,
        plainText: block.plainText ?? imagePlainText(block.alt),
      };
    }
    case "table": {
      return {
        ...block,
        rows: block.rows.map((row) =>
          row.map((cell) => ({
            ...cell,
            plainText: cell.plainText ?? projectPlainText(cell.inlines),
          })),
        ),
      };
    }
    default: {
      block satisfies never;
      return panic(`Unhandled block: ${String(block)}`);
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
 * Every `plainText` recomputed from the fields beside it.
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
    switch (block.type) {
      case "table": {
        const rows = block.rows.map((row) =>
          row.map((cell) => ({
            ...cell,
            plainText: projectPlainText(cell.inlines),
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
      case "image": {
        return { ...block, plainText: imagePlainText(block.alt) };
      }
      case "heading":
      case "paragraph": {
        return { ...block, plainText: projectPlainText(block.inlines) };
      }
      default: {
        block satisfies never;
        return panic(`Unhandled block: ${String(block)}`);
      }
    }
  }),
});

/**
 * The same AST with every rebuildable `plainText` dropped.
 *
 * Sound only because `projectPlainText` and the alt text are the single
 * producers of those fields: a reader rebuilds exactly what a parser
 * wrote. `parseDocumentAst` is the other half and refills them, so the
 * parsed `DocumentAst` keeps `plainText` required and no consumer of a
 * parsed AST sees the omission.
 */
export const omitDerivablePlainText = (ast: DocumentAst): WireDocumentAst => ({
  ...ast,
  blocks: ast.blocks.map((block): WireBlock => {
    // Every branch drops `plainText` and keeps the rest of the block by
    // spreading it. Listing the fields to keep instead would silently
    // drop each one added later.
    switch (block.type) {
      case "heading":
      case "paragraph":
      case "image": {
        const { plainText: _derived, ...rest } = block;
        return rest;
      }
      case "table": {
        return {
          ...block,
          rows: block.rows.map((row) =>
            row.map(({ plainText: _cellDerived, ...cell }) => cell),
          ),
        };
      }
      default: {
        block satisfies never;
        return panic(`Unhandled block: ${String(block)}`);
      }
    }
  }),
});

const inlineArraySchema = v.array(v.lazy(() => inlineSchema));

const HTTPS_PROTOCOL = "https:";

/**
 * An image address, and never image bytes.
 *
 * A `data:` URI inlines the payload: one scanned page is routinely
 * megabytes, and the AST is read, indexed, compressed and put in front of
 * a model as a whole, so those bytes would be paid for on every one of
 * those paths. Images belong in an asset store that the AST points at.
 * The same check rejects every other scheme, so an address is always one
 * a reader can fetch over TLS.
 */
const isHttpsUrl = (src: string): boolean =>
  URL.canParse(src) && new URL(src).protocol === HTTPS_PROTOCOL;

const imageSrcSchema = v.pipe(
  v.string(),
  v.url(),
  v.check(isHttpsUrl, "Image src must be an https URL"),
);

/** A span of more than one cell. A span of one is the default, so it is
 * absent rather than written as 1. */
const cellSpanSchema = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(2)),
);

const imagePixelsSchema = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(1)),
);

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
  role: v.optional(v.picklist(HEADING_ROLES)),
  inlines: inlineArraySchema,
};

const paragraphEntries = {
  id: v.string(),
  anchorId: v.string(),
  type: v.literal("paragraph"),
  role: v.optional(v.picklist(PARAGRAPH_ROLES)),
  note: v.optional(
    v.variant("type", [
      v.object({
        type: v.literal("footnote"),
        label: v.string(),
        noteId: v.optional(v.string()),
      }),
    ]),
  ),
  number: v.optional(v.pipe(v.number(), v.finite())),
  inlines: inlineArraySchema,
};

const imageEntries = {
  id: v.string(),
  anchorId: v.string(),
  type: v.literal("image"),
  src: imageSrcSchema,
  alt: v.optional(v.string()),
  width: imagePixelsSchema,
  height: imagePixelsSchema,
};

const tableCellEntries = {
  inlines: inlineArraySchema,
  colSpan: cellSpanSchema,
  rowSpan: cellSpanSchema,
  header: v.optional(v.literal(true)),
};

/** Table fields except `rows`, whose cells differ between the two readers. */
const tableEntries = {
  id: v.string(),
  anchorId: v.string(),
  type: v.literal("table"),
  role: v.optional(v.picklist(TABLE_ROLES)),
  plainText: v.string(),
};

const tableCellSchema: v.GenericSchema<TableCell> = v.object({
  ...tableCellEntries,
  plainText: v.string(),
});

const blockSchema: v.GenericSchema<Block> = v.variant("type", [
  v.object({ ...headingEntries, plainText: v.string() }),
  v.object({ ...paragraphEntries, plainText: v.string() }),
  v.object({ ...imageEntries, plainText: v.string() }),
  v.object({ ...tableEntries, rows: v.array(v.array(tableCellSchema)) }),
]);

const isMemberOf = <const TRoles extends readonly string[]>(
  roles: TRoles,
  role: string,
): role is TRoles[number] => roles.includes(role);

/**
 * A stored role the persisted reader does not recognise.
 *
 * `role` is the one closed set in a block that grows with every parser,
 * so a stored value this reader does not know is either a newer writer's
 * (a deployment in progress, a client bundle older than the API) or a row
 * written past the ingestion boundary. Either way it names a presentation
 * hint, not content: failing the whole document over it would take the
 * text down with the hint. The reader keeps the block and degrades the
 * role instead — to `fallback`, which for a paragraph is the declared
 * `unknown` and for the other block types is no role — while the
 * canonical `documentAstSchema` stays strict, so a writer still cannot
 * persist a role it does not declare. `persistedAstDegradations` reports
 * what was degraded so a stored row that needs repair is visible.
 */
const tolerantRole = <
  const TRoles extends readonly string[],
  TFallback extends TRoles[number] | undefined,
>(
  roles: TRoles,
  fallback: TFallback,
) =>
  v.optional(
    v.pipe(
      v.string(),
      v.transform((role): TRoles[number] | TFallback =>
        isMemberOf(roles, role) ? role : fallback,
      ),
    ),
  );

const wireTableCellSchema: v.GenericSchema<unknown, WireTableCell> = v.object({
  ...tableCellEntries,
  inlines: persistedInlineArraySchema,
  plainText: v.optional(v.string()),
});

/**
 * `blockSchema` with the rebuildable `plainText` fields made optional,
 * the roles read tolerantly (see `tolerantRole`) and the inline runs read
 * tolerantly (see `persistedInlineArraySchema`).
 */
const wireBlockSchema: v.GenericSchema<unknown, WireBlock> = v.variant("type", [
  v.object({
    ...headingEntries,
    inlines: persistedInlineArraySchema,
    role: tolerantRole(HEADING_ROLES, undefined),
    plainText: v.optional(v.string()),
  }),
  v.object({
    ...paragraphEntries,
    inlines: persistedInlineArraySchema,
    role: tolerantRole(PARAGRAPH_ROLES, "unknown"),
    plainText: v.optional(v.string()),
  }),
  v.object({ ...imageEntries, plainText: v.optional(v.string()) }),
  v.object({
    ...tableEntries,
    role: tolerantRole(TABLE_ROLES, undefined),
    rows: v.array(v.array(wireTableCellSchema)),
  }),
]);

/**
 * A block read from storage, or `null` for a block kind this reader does
 * not declare.
 *
 * Unlike a role or an inline kind, an unknown block has no neutral shape
 * to degrade to: nothing here knows where its text lives or how it should
 * read. It is dropped, and reported, rather than guessed at.
 */
const persistedBlockSchema: v.GenericSchema<unknown, WireBlock | null> =
  v.union([
    wireBlockSchema,
    v.pipe(
      v.object({
        type: v.pipe(
          v.string(),
          v.check((type) => !Object.hasOwn(BLOCK_ROLES, type)),
        ),
      }),
      v.transform((): null => null),
    ),
  ]);

/** What the persisted reader could not read as written, per occurrence. */
export type PersistedAstDegradation =
  | {
      kind: "block-role";
      blockId: string | null;
      type: Block["type"];
      role: string;
    }
  | { kind: "block-type"; blockId: string | null; type: string }
  | { kind: "inline-type"; blockId: string | null; type: string };

const storedBlockShape = v.object({
  id: v.optional(v.string()),
  type: v.string(),
  role: v.optional(v.string()),
  inlines: v.optional(v.unknown()),
  rows: v.optional(v.unknown()),
});

const storedRowsShape = v.array(v.array(v.object({ inlines: v.unknown() })));

const storedBlocksShape = v.object({
  blocks: v.array(v.unknown()),
});

const isBlockType = (type: string): type is Block["type"] =>
  Object.hasOwn(BLOCK_ROLES, type);

/** Every raw inline `type` a block carries, in its inline run and, for a
 * table, in each cell's run. */
const blockInlineTypes = (block: {
  inlines?: unknown;
  rows?: unknown;
}): string[] => {
  const types = rawInlineTypes(block.inlines);
  const rows = v.safeParse(storedRowsShape, block.rows);
  if (!rows.success) {
    return types;
  }
  for (const row of rows.output) {
    for (const cell of row) {
      types.push(...rawInlineTypes(cell.inlines));
    }
  }
  return types;
};

/**
 * What a stored AST carries that the persisted reader degrades: a block
 * role it does not declare, a block kind it drops, an inline kind it
 * collapses to text.
 *
 * Reads the raw value, not the parsed AST, because parsing is where the
 * information is lost. A value that is not an AST at all reports nothing:
 * that failure is the parser's to raise.
 *
 * An unknown inline kind is reported once per block that carries it, not
 * once per occurrence: a stored row repeats a kind on every run, and the
 * report exists to name the row and the kind, not to count them.
 */
export const persistedAstDegradations = (
  raw: unknown,
): readonly PersistedAstDegradation[] => {
  const stored = v.safeParse(storedBlocksShape, raw);
  if (!stored.success) {
    return [];
  }
  const degradations: PersistedAstDegradation[] = [];
  for (const candidate of stored.output.blocks) {
    const parsed = v.safeParse(storedBlockShape, candidate);
    if (!parsed.success) {
      continue;
    }
    const { id, role, type } = parsed.output;
    const blockId = id ?? null;
    if (!isBlockType(type)) {
      degradations.push({ kind: "block-type", blockId, type });
      continue;
    }
    if (role !== undefined && !isMemberOf(BLOCK_ROLES[type], role)) {
      degradations.push({ kind: "block-role", blockId, type, role });
    }
    const seen = new Set<string>();
    for (const inlineType of blockInlineTypes(parsed.output)) {
      if (isKnownInlineType(inlineType) || seen.has(inlineType)) {
        continue;
      }
      seen.add(inlineType);
      degradations.push({ kind: "inline-type", blockId, type: inlineType });
    }
  }
  return degradations;
};

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

const footnoteOf = (block: Block): ParagraphNote | null =>
  block.type === "paragraph" && block.note?.type === "footnote"
    ? block.note
    : null;

/**
 * Whether every run of adjacent footnote paragraphs sharing a `noteId`
 * repeats one label. The parts of one footnote are grouped by `noteId`
 * alone on read, so two notes written under one id with different labels
 * would render as one note with the second label lost; a writer must not
 * persist that.
 */
export const footnoteGroupsShareLabels = (
  blocks: readonly Block[],
): boolean => {
  let previous: ParagraphNote | null = null;
  for (const block of blocks) {
    const note = footnoteOf(block);
    if (
      note !== null &&
      previous !== null &&
      note.noteId !== undefined &&
      note.noteId === previous.noteId &&
      note.label !== previous.label
    ) {
      return false;
    }
    previous = note;
  }
  return true;
};

export const documentAstSchema: v.GenericSchema<DocumentAst> = v.pipe(
  v.object({
    version: v.literal(1),
    source: documentAstSourceSchema,
    metadata: documentAstMetadataSchema,
    blocks: v.array(blockSchema),
  }),
  v.check(
    ({ blocks }) => footnoteGroupsShareLabels(blocks),
    "Adjacent footnote paragraphs sharing a noteId must repeat one label",
  ),
);

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
  blocks: v.array(persistedBlockSchema),
});

/**
 * Persisted version-1 ASTs predate required source and metadata fields.
 * Normalize those sparse historical rows at the storage boundary while
 * keeping the canonical runtime guard sound.
 *
 * A block whose rebuildable `plainText` the sender dropped is refilled
 * here from the fields beside it, so the parsed `DocumentAst` keeps
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
      blocks: blocks.flatMap((block) =>
        block === null ? [] : [fillBlockPlainText(block)],
      ),
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
