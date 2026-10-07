// parser-output-unchanged: shared exclusion and text helpers discard the same script/style content as the existing walks.
/**
 * Block machinery shared by the CourtListener text formats: a builder that
 * numbers blocks under one opinion row's prefix and groups them into
 * structural units, and a walker from a publisher DOM to those blocks.
 *
 * Inline content goes through `walkInlines`; this module adds only what the
 * block level needs: footnote grouping, page anchors between blocks and
 * opinion containers. A format declares its vocabulary; the walk is one.
 */

import { panic } from "better-result";
import type * as cheerio from "cheerio";
import {
  type AnyNode,
  type Element,
  hasChildren,
  isCDATA,
  isTag,
  isText,
  type ParentNode,
  Text,
} from "domhandler";

import {
  type Block,
  hasInlineChildren,
  type Inline,
  type ParagraphRole,
  plainTextOf,
  projectPlainText,
  type TableCell,
} from "@stll/legal-ast/document-ast";

import {
  appendTextInline,
  isExcludedHtmlTag,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";

import type { UnitPosition } from "./opinion-class";
import type { TextUnit } from "./outcome";

export type PageAnchor = Extract<Inline, { type: "page-anchor" }>;

/** A paragraph role, or `body`: whatever the enclosing opinion's class is. */
export type DraftRole = ParagraphRole | "body";

// ── Whitespace ──────────────────────────────────────────

const MARKUP_SPACE = /[ \t\n\r\f]+/gu;

const collapseRuns = (
  inlines: readonly Inline[],
  state: { space: boolean },
): Inline[] => {
  const result: Inline[] = [];
  for (const node of inlines) {
    if (node.type === "text") {
      let text = node.text.replace(MARKUP_SPACE, " ");
      if (state.space && text.startsWith(" ")) {
        text = text.slice(1);
      }
      if (text !== "") {
        state.space = text.endsWith(" ");
        appendTextInline(result, text, node.anonymized === true);
      }
    } else if (node.type === "line-break") {
      state.space = true;
      result.push(node);
    } else if (hasInlineChildren(node)) {
      const children = collapseRuns(node.children, state);
      if (children.length > 0) {
        result.push({ ...node, children });
      }
    } else {
      result.push(node);
    }
  }
  return result;
};

/** Drops trailing whitespace, looking through wrappers and past anchors. */
const trimTrailing = (inlines: readonly Inline[]): Inline[] => {
  const result = [...inlines];
  const anchors: Inline[] = [];
  while (result.length > 0) {
    const last = result.at(-1);
    if (last === undefined) {
      break;
    }
    if (last.type === "page-anchor") {
      anchors.unshift(last);
      result.pop();
      continue;
    }
    if (last.type === "line-break") {
      result.pop();
      continue;
    }
    if (last.type === "text") {
      const text = last.text.trimEnd();
      if (text !== "") {
        result[result.length - 1] = { ...last, text };
        break;
      }
      result.pop();
      continue;
    }
    if (!hasInlineChildren(last)) {
      break;
    }
    const children = trimTrailing(last.children);
    if (children.length > 0) {
      result[result.length - 1] = { ...last, children };
      break;
    }
    result.pop();
  }
  return [...result, ...anchors];
};

/**
 * Markup whitespace as a reader sees it: every run one space, none at either
 * end of the block. Markup indentation is not the court's text.
 */
const collapseMarkupWhitespace = (inlines: readonly Inline[]): Inline[] =>
  trimTrailing(collapseRuns(inlines, { space: true }));

const countAnchors = (inlines: readonly Inline[]): number => {
  let count = 0;
  for (const node of inlines) {
    if (node.type === "page-anchor") {
      count += 1;
    } else if (hasInlineChildren(node)) {
      count += countAnchors(node.children);
    }
  }
  return count;
};

// ── Builder ─────────────────────────────────────────────

type Frame = {
  readonly id: number;
  readonly kind: TextUnit["kind"];
  readonly domType: string | null;
  readonly position: UnitPosition;
};

type UnitBuilder = ReturnType<typeof createUnitBuilder>;

const outsideFrame = (id: number): Frame => ({
  id,
  kind: "outside",
  domType: null,
  position: "row",
});

const tableBlock = ({
  rows,
  number,
  note,
  prefix,
}: {
  rows: TableCell[][];
  number: number;
  note: { label: string; noteId: string; blocks: number } | null;
  prefix: string;
}): Block => {
  let anchorId = `${prefix}-t${number}`;
  if (note !== null) {
    anchorId =
      note.blocks === 0
        ? note.noteId
        : `${note.noteId}-${String(note.blocks + 1)}`;
  }
  return {
    id: `${prefix}-b${number}`,
    anchorId,
    type: "table",
    ...(note === null
      ? {}
      : {
          note: {
            type: "footnote" as const,
            label: note.label,
            noteId: note.noteId,
          },
        }),
    rows,
    plainText: rows
      .map((row) => row.map((cell) => cell.plainText).join("\t"))
      .join("\n"),
  };
};

const buildTextUnits = (
  units: { frame: Frame; blocks: Block[] }[],
  boundaries: TextUnit["boundaries"],
): TextUnit[] =>
  units.map(({ blocks, frame }) => ({
    kind: frame.kind,
    domType: frame.domType,
    position: frame.position,
    boundaries,
    blocks,
  }));

/**
 * Numbers one opinion row's blocks under `prefix` and groups them into units:
 * a unit closes wherever the innermost opinion element changes, so a nested
 * opinion and the text after it are separate runs.
 *
 * A footnote is several paragraphs sharing one `noteId` and repeating one
 * label. Page anchors met between blocks open the next inline block; a
 * paragraph holding nothing but anchors hands them on the same way.
 */
export const createUnitBuilder = ({
  blockAllowance,
  bodyRole,
  boundaries,
  prefix,
  rootOpinionPolicy,
}: {
  readonly prefix: string;
  /** XML declares separate root opinions; extra HTML wrappers cannot inherit the row class. */
  readonly rootOpinionPolicy: "single" | "multiple";
  /** The role of body text under an opinion element of this DOM type. */
  readonly bodyRole: (
    domType: string | null,
    position: UnitPosition,
  ) => ParagraphRole;
  /** Blocks this row may still emit; past it the row is over the limit. */
  readonly blockAllowance: number;
  readonly boundaries: TextUnit["boundaries"];
}) => {
  const units: { frame: Frame; blocks: Block[] }[] = [];
  const captionFrame = outsideFrame(-1);
  const frames: Frame[] = [];
  let nextFrame = 0;
  let rootOpinions = 0;
  let outside = outsideFrame(nextFrame);
  let blockNumber = 0;
  let overLimit = false;
  let noteNumber = 0;
  let pending: PageAnchor[] = [];
  let note: { label: string; noteId: string; blocks: number } | null = null;
  const counts = { pageAnchors: 0, notes: 0 };

  const current = (): Frame => frames.at(-1) ?? outside;

  /** The next block's number, or `null` once the allowance is spent. */
  const nextBlock = (): number | null => {
    if (blockNumber >= blockAllowance) {
      overLimit = true;
      return null;
    }
    blockNumber += 1;
    return blockNumber;
  };

  const push = (block: Block) => {
    const caption =
      block.type === "paragraph" &&
      block.note === undefined &&
      (block.role === "front-matter" ||
        block.role === "parties" ||
        block.role === "case-number");
    const frame =
      caption && current().kind === "opinion" ? captionFrame : current();
    const last = units.at(-1);
    if (last?.frame.id === frame.id) {
      last.blocks.push(block);
    } else {
      units.push({ frame, blocks: [block] });
    }
  };

  const withPending = (inlines: Inline[]): Inline[] => {
    if (pending.length === 0) {
      return inlines;
    }
    const opened = [...pending, ...inlines];
    pending = [];
    return opened;
  };

  const resolve = (role: DraftRole): ParagraphRole =>
    role === "body" ? bodyRole(current().domType, current().position) : role;

  const paragraph = (source: Inline[], role: DraftRole) => {
    const plainText = projectPlainText(source);
    if (plainText === "") {
      // Anchors of an empty paragraph belong to the next block.
      pending.push(
        ...source.filter(
          (node): node is PageAnchor => node.type === "page-anchor",
        ),
      );
      return;
    }
    const number = nextBlock();
    if (number === null) {
      return;
    }
    const inlines = withPending(source);
    counts.pageAnchors += countAnchors(inlines);
    const id = `${prefix}-b${number}`;
    if (note === null) {
      push({
        id,
        anchorId: `${prefix}-p${number}`,
        type: "paragraph",
        role: resolve(role),
        inlines,
        plainText,
      });
      return;
    }
    note.blocks += 1;
    push({
      id,
      anchorId:
        note.blocks === 1 ? note.noteId : `${note.noteId}-${note.blocks}`,
      type: "paragraph",
      role: resolve(role),
      note: { type: "footnote", label: note.label, noteId: note.noteId },
      inlines,
      plainText,
    });
  };

  return {
    enterOpinion: (domType: string | null) => {
      nextFrame += 1;
      if (frames.length === 0) {
        rootOpinions += 1;
      }
      frames.push({
        id: nextFrame,
        kind: "opinion",
        domType,
        position: (() => {
          if (frames.length > 0) {
            return "nested";
          }
          if (rootOpinions === 1 || rootOpinionPolicy === "multiple") {
            return "row";
          }
          return "sibling";
        })(),
      });
    },
    exitOpinion: () => {
      frames.pop();
      if (frames.length === 0) {
        // Text after the last opinion is a new outside run, not the caption.
        nextFrame += 1;
        outside = outsideFrame(nextFrame);
      }
    },
    /** A heading inside a note is one of its paragraphs. */
    heading: (source: Inline[]) => {
      const plainText = projectPlainText(source);
      if (note !== null || plainText === "") {
        paragraph(source, "body");
        return;
      }
      const number = nextBlock();
      if (number === null) {
        return;
      }
      const inlines = withPending(source);
      counts.pageAnchors += countAnchors(inlines);
      push({
        id: `${prefix}-b${number}`,
        anchorId: `${prefix}-h${number}`,
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines,
        plainText,
      });
    },
    paragraph,
    table: (rows: TableCell[][]) => {
      const cells = rows.flat();
      const number = cells.every((cell) => cell.plainText === "")
        ? null
        : nextBlock();
      if (number === null) {
        return;
      }
      const block = tableBlock({ rows, number, note, prefix });
      if (note !== null) {
        note.blocks += 1;
      }
      push(block);
    },
    /** Blocks emitted until `endNote` are one footnote. */
    beginNote: (label: string) => {
      noteNumber += 1;
      note = { label, noteId: `${prefix}-fn${noteNumber}`, blocks: 0 };
    },
    endNote: () => {
      if (note !== null && note.blocks > 0) {
        counts.notes += 1;
      }
      note = null;
    },
    finish: (): {
      units: TextUnit[];
      pageAnchors: number;
      notes: number;
      overLimit: boolean;
    } => {
      const last = units.at(-1)?.blocks.at(-1);
      if (pending.length > 0 && last !== undefined && "inlines" in last) {
        // Anchors after the last block close it.
        last.inlines.push(...pending);
        counts.pageAnchors += pending.length;
        pending = [];
      }
      // Only the row's own first opinion can open with its root title.
      return {
        units: buildTextUnits(units, boundaries),
        ...counts,
        overLimit,
      };
    },
  };
};

// ── DOM walk ────────────────────────────────────────────

/** What a format's elements mean at the block level. */
export type BodyVocabulary = {
  /** Elements that are one paragraph each, by role. */
  readonly paragraphs: Readonly<Record<string, DraftRole>>;
  /**
   * An element whose attributes, not its name, give it a block meaning: a
   * paragraph role, or `heading`. Consulted before `paragraphs`.
   */
  readonly semantics?: (element: Element) => DraftRole | "heading" | undefined;
  /** Elements printed as an opinion's heading (an author line). */
  readonly headings: ReadonlySet<string>;
  /** Elements that only group blocks. */
  readonly containers: ReadonlySet<string>;
  /** Elements that are inline wherever they occur. */
  readonly inlines: ReadonlySet<string>;
  /** A structural opinion, with the publisher's type for it. */
  readonly opinion: (element: Element) => { domType: string | null } | null;
  /** A footnote, with its printed mark. */
  readonly footnote: (element: Element) => { label: string } | null;
  /** Inside a footnote, the element that only links back to its callout. */
  readonly backlink: (element: Element) => boolean;
  readonly pageAnchor: (element: Element) => PageAnchor | undefined;
};

/** An element's name without its namespace prefix, lower-cased. */
const nameOf = (element: Element): string =>
  (element.name.split(":").at(-1) ?? element.name).toLowerCase();

/** The parts of a table below the table itself. */
const TABLE_PARTS = new Set([
  "caption",
  "col",
  "colgroup",
  "colspec",
  "tbody",
  "td",
  "tfoot",
  "tgroup",
  "th",
  "thead",
  "tr",
]);

/** A row's cell elements. */
const CELLS = new Set(["td", "th"]);

/** A table's row groups, the CALS `tgroup` among them. */
const ROW_GROUPS = new Set(["tbody", "tfoot", "tgroup", "thead"]);

/**
 * Elements that render a picture, a formula or embedded content rather than
 * text. None is declared decorative, so each holds the opinion for its asset.
 */
const GRAPHICS = new Set([
  "canvas",
  "embed",
  "iframe",
  "image",
  "img",
  "math",
  "object",
  "picture",
  "svg",
  "video",
]);

/** A node's text with no markup, CDATA included. */
export const textOf = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  return hasChildren(node) ? node.children.map(textOf).join("") : "";
};

/**
 * Replaces every CDATA section below `root` with a text node of its
 * content, so every walk reads it where it stands: CDATA is text in XML.
 */
export const cdataAsText = (root: ParentNode): void => {
  const stack: ParentNode[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop();
    if (parent === undefined) {
      break;
    }
    for (const [index, child] of parent.children.entries()) {
      if (isCDATA(child)) {
        const text = new Text(textOf(child));
        text.parent = parent;
        text.prev = child.prev;
        text.next = child.next;
        if (child.prev !== null) {
          child.prev.next = text;
        }
        if (child.next !== null) {
          child.next.prev = text;
        }
        parent.children[index] = text;
      } else if (hasChildren(child)) {
        stack.push(child);
      }
    }
  }
};

/** The graphic constructs below `root`, by element name. */
export const graphicsIn = (root: ParentNode): Record<string, number> => {
  const found: Record<string, number> = {};
  const stack: AnyNode[] = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (isTag(node) && GRAPHICS.has(nameOf(node))) {
      const name = nameOf(node);
      found[name] = (found[name] ?? 0) + 1;
    }
    if (hasChildren(node)) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }
  return found;
};

/**
 * The source's visible text, read from the markup without the block walk:
 * every text node in document order less script, style and the declared
 * removals (printed page labels, note backlinks), broken into paragraphs at
 * every element that is not inline.
 */
export const sourceTextOf = (
  root: ParentNode,
  vocabulary: BodyVocabulary,
): {
  readonly paragraphs: readonly string[];
  readonly paginationCharacters: number;
  readonly backlinkCharacters: number;
} => {
  const paragraphs: string[] = [];
  let current = "";
  let paginationCharacters = 0;
  let backlinkCharacters = 0;
  const close = () => {
    if (current.trim() !== "") {
      paragraphs.push(current);
    }
    current = "";
  };
  const visit = (node: AnyNode, inNote: boolean) => {
    if (isText(node) || isCDATA(node)) {
      current += textOf(node);
      return;
    }
    if (!isTag(node) || isExcludedHtmlTag(nameOf(node))) {
      return;
    }
    const anchor = vocabulary.pageAnchor(node);
    if (anchor !== undefined) {
      // Only the printed page (`*123`) leaves the text: anything more a
      // marker holds stays in the source, where the block walk has lost it.
      const markerText = textOf(node);
      const printed = markerText.replace(/\s+/gu, "");
      const label = `*${anchor.label}`;
      const rest = printed.startsWith(label)
        ? printed.slice(label.length)
        : printed.replace(/^\*?/u, "").replace(anchor.label, "");
      paginationCharacters += printed.length - rest.length;
      if (rest !== "") {
        current += ` ${rest} `;
      } else if (/^\s|\s$/u.test(markerText)) {
        // walkInlines retains a separator owned by either edge of the marker.
        current += " ";
      }
      return;
    }
    if (inNote && vocabulary.backlink(node)) {
      backlinkCharacters += textOf(node).trim().length;
      return;
    }
    const name = nameOf(node);
    if (name === "br") {
      current += " ";
      return;
    }
    const inline = vocabulary.inlines.has(name);
    if (!inline) {
      close();
    }
    const note = vocabulary.footnote(node) !== null;
    for (const child of node.children) {
      visit(child, note);
    }
    if (!inline) {
      close();
    }
  };
  for (const child of root.children) {
    visit(child, false);
  }
  close();
  return { paragraphs, paginationCharacters, backlinkCharacters };
};

const blockText = (block: Block): string => {
  switch (block.type) {
    case "table":
      return block.rows
        .flat()
        .map(({ inlines }) => plainTextOf(inlines))
        .join(" ");
    case "image":
      return block.plainText;
    case "heading":
    case "paragraph":
      return plainTextOf(block.inlines);
    default: {
      block satisfies never;
      return panic(`Unhandled block: ${String(block)}`);
    }
  }
};

/**
 * Whether the blocks hold exactly the source's visible characters, in the
 * source's order. Whitespace is layout and not compared; a character lost,
 * repeated or moved anywhere fails it, however small against the rest.
 */
export const conservesText = (
  source: string,
  units: readonly TextUnit[],
): boolean => {
  const visibleSource = source.replace(/\s/gu, "");
  const visibleBlocks = units
    .flatMap(({ blocks }) => blocks.map(blockText))
    .join(" ")
    .replace(/\s/gu, "");
  return visibleSource === visibleBlocks;
};

/**
 * Walks tables into `builder`: each grid as table blocks, and everything
 * else visible in a table (a caption, text between rows) as paragraphs
 * beside the grid, in document order.
 */
const createTableWalker = ({
  builder,
  isBlock,
  readRun,
  vocabulary,
}: {
  readonly builder: UnitBuilder;
  readonly isBlock: (element: Element) => boolean;
  readonly readRun: (nodes: readonly AnyNode[]) => Inline[];
  readonly vocabulary: BodyVocabulary;
}) => {
  /**
   * An element's text as one inline run, with a line break wherever a block
   * inside it ends: a cell holding paragraphs or a nested table keeps its
   * parts apart instead of welding their words together.
   */
  const flowInlines = (element: Element): Inline[] => {
    const parts: Inline[][] = [];
    let run: AnyNode[] = [];
    const flush = () => {
      if (run.length > 0) {
        parts.push(readRun(run));
        run = [];
      }
    };
    for (const child of element.children) {
      if (isText(child)) {
        run.push(child);
        continue;
      }
      if (!isTag(child) || isExcludedHtmlTag(nameOf(child))) {
        continue;
      }
      if (vocabulary.pageAnchor(child) !== undefined || !isBlock(child)) {
        run.push(child);
        continue;
      }
      flush();
      parts.push(flowInlines(child));
    }
    flush();
    const flowed: Inline[] = [];
    for (const part of parts) {
      if (part.length === 0) {
        continue;
      }
      if (flowed.length > 0) {
        flowed.push({ type: "line-break" });
      }
      flowed.push(...part);
    }
    return flowed;
  };

  const cellOf = (cell: AnyNode): TableCell | null => {
    if (isText(cell)) {
      const inlines = collapseMarkupWhitespace([
        { type: "text", text: cell.data },
      ]);
      return inlines.length === 0
        ? null
        : { inlines, plainText: projectPlainText(inlines) };
    }
    if (!isTag(cell) || isExcludedHtmlTag(nameOf(cell))) {
      return null;
    }
    const inlines = flowInlines(cell);
    const colSpan = Number(cell.attribs["colspan"] ?? "1");
    const rowSpan = Number(cell.attribs["rowspan"] ?? "1");
    return {
      inlines,
      plainText: projectPlainText(inlines),
      ...(Number.isInteger(colSpan) && colSpan > 1 ? { colSpan } : {}),
      ...(Number.isInteger(rowSpan) && rowSpan > 1 ? { rowSpan } : {}),
      ...(nameOf(cell) === "th" ? { header: true as const } : {}),
    };
  };

  /**
   * A table's grid as table blocks, and everything else visible in it (a
   * caption, text between rows) as paragraphs beside the grid, in document
   * order. Text a row holds outside its cells becomes a cell of its own.
   */
  const walkTable = (table: Element, inherited: DraftRole) => {
    let rows: TableCell[][] = [];
    const flushRows = () => {
      if (rows.length > 0) {
        builder.table(rows);
        rows = [];
      }
    };
    const visitRows = (container: Element) => {
      for (const child of container.children) {
        if (isText(child)) {
          if (child.data.trim() !== "") {
            flushRows();
            builder.paragraph(readRun([child]), inherited);
          }
          continue;
        }
        if (!isTag(child) || isExcludedHtmlTag(nameOf(child))) {
          continue;
        }
        const name = nameOf(child);
        if (name === "tr") {
          rows.push(
            child.children.flatMap((cell) => {
              const read = cellOf(cell);
              return read === null ? [] : [read];
            }),
          );
        } else if (ROW_GROUPS.has(name)) {
          visitRows(child);
        } else if (name === "caption") {
          flushRows();
          builder.paragraph(flowInlines(child), inherited);
        } else if (!CELLS.has(name) && textOf(child).trim() === "") {
          // Column declarations and other empty parts carry no text.
        } else {
          flushRows();
          builder.paragraph(flowInlines(child), inherited);
        }
      }
    };
    visitRows(table);
    flushRows();
  };

  return walkTable;
};

/**
 * Walks `root`'s children into `builder`. Every visible element contributes
 * its text somewhere: an element outside the vocabulary is walked as a
 * container when it holds blocks and read as an `unknown` paragraph when it
 * does not, and counted either way.
 */
export const walkBody = ({
  $,
  builder,
  root,
  vocabulary,
}: {
  readonly $: cheerio.CheerioAPI;
  readonly root: ParentNode;
  readonly vocabulary: BodyVocabulary;
  readonly builder: UnitBuilder;
}): { readonly unknownConstructs: Record<string, number> } => {
  const unknownConstructs: Record<string, number> = {};
  const inlineOptions = {
    // Publisher links are provenance, not Stella links: their words stay.
    sanitizeHref: () => undefined,
    pageAnchor: vocabulary.pageAnchor,
  };
  const containsBlock = new WeakMap<Element, boolean>();

  const isInline = (element: Element): boolean => {
    const name = nameOf(element);
    return vocabulary.inlines.has(name) || name === "br";
  };

  const isKnownBlock = (element: Element): boolean => {
    const name = nameOf(element);
    return (
      vocabulary.containers.has(name) ||
      vocabulary.headings.has(name) ||
      vocabulary.semantics?.(element) !== undefined ||
      Object.hasOwn(vocabulary.paragraphs, name) ||
      name === "table" ||
      vocabulary.opinion(element) !== null ||
      vocabulary.footnote(element) !== null
    );
  };

  const isKnown = (element: Element): boolean =>
    isInline(element) ||
    isKnownBlock(element) ||
    TABLE_PARTS.has(nameOf(element));

  /** Whether a declared block element sits anywhere below `element`. */
  const holdsBlocks = (element: Element): boolean => {
    const cached = containsBlock.get(element);
    if (cached !== undefined) {
      return cached;
    }
    const holds = element.children.some(
      (child) => isTag(child) && (isKnownBlock(child) || holdsBlocks(child)),
    );
    containsBlock.set(element, holds);
    return holds;
  };

  /**
   * At the block level an undeclared element is a block of its own: merged
   * into a neighbouring run its text would read as that run's.
   */
  const isBlock = (element: Element): boolean =>
    !isInline(element) || holdsBlocks(element);

  const count = (element: Element) => {
    const name = nameOf(element);
    unknownConstructs[name] = (unknownConstructs[name] ?? 0) + 1;
  };

  const preformatted = (nodes: readonly Inline[]): Inline[] =>
    nodes.flatMap((node): Inline[] => {
      if (hasInlineChildren(node)) {
        return [{ ...node, children: preformatted(node.children) }];
      }
      if (node.type !== "text") {
        return [node];
      }
      return node.text
        .replace(/\r\n?/gu, "\n")
        .split("\n")
        .flatMap((text, index): Inline[] => {
          const result: Inline[] = [];
          if (index > 0) {
            result.push({ type: "line-break" });
          }
          if (text !== "") {
            result.push({ ...node, text });
          }
          return result;
        });
    });
  const readInlines = (element: Element): Inline[] => {
    const inlines = walkInlines($, $(element), inlineOptions);
    return nameOf(element) === "pre"
      ? preformatted(inlines)
      : collapseMarkupWhitespace(inlines);
  };

  const readRun = (nodes: readonly AnyNode[]): Inline[] => {
    const wrapper = $("<cl-run></cl-run>");
    for (const node of nodes) {
      wrapper.append($(node).clone());
    }
    const [element] = wrapper.toArray();
    return element !== undefined && isTag(element) ? readInlines(element) : [];
  };

  const countInlineUnknowns = (element: Element) => {
    for (const child of element.children) {
      if (isTag(child)) {
        if (!isKnown(child)) {
          count(child);
        }
        countInlineUnknowns(child);
      }
    }
  };

  const walkContainer = (
    container: ParentNode,
    inherited: DraftRole,
    skip: (element: Element) => boolean = () => false,
  ) => {
    let run: AnyNode[] = [];
    const flush = () => {
      if (run.length > 0) {
        builder.paragraph(readRun(run), inherited);
        run = [];
      }
    };
    for (const child of container.children) {
      if (isText(child)) {
        run.push(child);
        continue;
      }
      if (!isTag(child) || isExcludedHtmlTag(nameOf(child)) || skip(child)) {
        continue;
      }
      if (vocabulary.pageAnchor(child) !== undefined || !isBlock(child)) {
        countInlineUnknowns(child);
        run.push(child);
        continue;
      }
      flush();
      walkBlock(child, inherited);
    }
    flush();
  };

  const walkNote = (element: Element, label: string, inherited: DraftRole) => {
    builder.beginNote(label);
    walkContainer(element, inherited, vocabulary.backlink);
    builder.endNote();
  };

  const walkTable = createTableWalker({
    builder,
    isBlock,
    readRun,
    vocabulary,
  });

  const walkBlock = (element: Element, inherited: DraftRole) => {
    const name = nameOf(element);
    const opinion = vocabulary.opinion(element);
    if (opinion !== null) {
      builder.enterOpinion(opinion.domType);
      walkContainer(element, "body");
      builder.exitOpinion();
      return;
    }
    const footnote = vocabulary.footnote(element);
    if (footnote !== null) {
      walkNote(element, footnote.label, inherited);
      return;
    }
    if (name === "table") {
      walkTable(element, inherited);
      return;
    }
    const semantic = vocabulary.semantics?.(element);
    const heading =
      semantic === "heading" ||
      (semantic === undefined && vocabulary.headings.has(name));
    if (heading && !holdsBlocks(element)) {
      countInlineUnknowns(element);
      builder.heading(readInlines(element));
      return;
    }
    const declared =
      semantic === undefined || semantic === "heading"
        ? vocabulary.paragraphs[name]
        : semantic;
    const role: DraftRole =
      declared === undefined || declared === "body" ? inherited : declared;
    if (!isKnown(element)) {
      count(element);
    }
    if (vocabulary.containers.has(name) || holdsBlocks(element)) {
      walkContainer(element, role);
      return;
    }
    countInlineUnknowns(element);
    builder.paragraph(
      readInlines(element),
      isKnown(element) ? role : "unknown",
    );
  };

  walkContainer(root, "body");
  return { unknownConstructs };
};
