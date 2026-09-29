/**
 * Block machinery shared by the CourtListener text formats: a builder that
 * numbers blocks under one opinion row's prefix and groups them into
 * structural units, and a walker from a publisher DOM to those blocks.
 *
 * Inline content goes through `walkInlines`; this module adds only what the
 * block level needs: footnote grouping, page anchors between blocks and
 * opinion containers. A format declares its vocabulary; the walk is one.
 */

import type * as cheerio from "cheerio";
import {
  type AnyNode,
  type Element,
  isTag,
  isText,
  type ParentNode,
} from "domhandler";

import {
  type Block,
  hasInlineChildren,
  type Inline,
  type ParagraphRole,
  projectPlainText,
  type TableCell,
} from "@/api/handlers/case-law/document-ast";
import {
  appendTextInline,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";

import type { TextUnit } from "./outcome";

export type PageAnchor = Extract<Inline, { type: "page-anchor" }>;

/** A paragraph role, or `body`: whatever the enclosing opinion's class is. */
type DraftRole = ParagraphRole | "body";

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
};

type UnitBuilder = ReturnType<typeof createUnitBuilder>;

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
  prefix,
}: {
  readonly prefix: string;
  /** The role of body text under an opinion element of this DOM type. */
  readonly bodyRole: (domType: string | null) => ParagraphRole;
  /** Blocks this row may still emit; past it the row is over the limit. */
  readonly blockAllowance: number;
}) => {
  const units: { frame: Frame; blocks: Block[] }[] = [];
  const frames: Frame[] = [];
  let nextFrame = 0;
  let outside: Frame = { id: nextFrame, kind: "outside", domType: null };
  let blockNumber = 0;
  let overLimit = false;
  let noteNumber = 0;
  let pending: PageAnchor[] = [];
  let note: { label: string; noteId: string; paragraphs: number } | null = null;
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
    const frame = current();
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
    role === "body" ? bodyRole(current().domType) : role;

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
    note.paragraphs += 1;
    push({
      id,
      anchorId:
        note.paragraphs === 1
          ? note.noteId
          : `${note.noteId}-${note.paragraphs}`,
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
      frames.push({ id: nextFrame, kind: "opinion", domType });
    },
    exitOpinion: () => {
      frames.pop();
      if (frames.length === 0) {
        // Text after the last opinion is a new outside run, not the caption.
        nextFrame += 1;
        outside = { id: nextFrame, kind: "outside", domType: null };
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
      push({
        id: `${prefix}-b${number}`,
        anchorId: `${prefix}-t${number}`,
        type: "table",
        rows,
        plainText: rows
          .map((row) => row.map((cell) => cell.plainText).join("\t"))
          .join("\n"),
      });
    },
    /** Paragraphs emitted until `endNote` are one footnote. */
    beginNote: (label: string) => {
      noteNumber += 1;
      note = { label, noteId: `${prefix}-fn${noteNumber}`, paragraphs: 0 };
    },
    endNote: () => {
      if (note !== null && note.paragraphs > 0) {
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
      return {
        units: units.map(({ blocks, frame }) => ({
          kind: frame.kind,
          domType: frame.domType,
          blocks,
        })),
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

const nameOf = (element: Element): string => element.name.toLowerCase();

const IGNORED = new Set(["script", "style"]);

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
      Object.hasOwn(vocabulary.paragraphs, name) ||
      name === "table" ||
      vocabulary.opinion(element) !== null ||
      vocabulary.footnote(element) !== null
    );
  };

  const isKnown = (element: Element): boolean =>
    isInline(element) || isKnownBlock(element);

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

  const readInlines = (element: Element): Inline[] =>
    collapseMarkupWhitespace(walkInlines($, $(element), inlineOptions));

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
      if (!isTag(child) || IGNORED.has(nameOf(child)) || skip(child)) {
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

  const readTable = (element: Element): TableCell[][] =>
    $(element)
      .find("tr")
      .toArray()
      .filter((row) => $(row).closest("table").get(0) === element)
      .map((row) =>
        $(row)
          .children("td, th")
          .toArray()
          .flatMap((cell) => {
            if (!isTag(cell)) {
              return [];
            }
            const inlines = readInlines(cell);
            const colSpan = Number($(cell).attr("colspan") ?? "1");
            const rowSpan = Number($(cell).attr("rowspan") ?? "1");
            return [
              {
                inlines,
                plainText: projectPlainText(inlines),
                ...(Number.isInteger(colSpan) && colSpan > 1
                  ? { colSpan }
                  : {}),
                ...(Number.isInteger(rowSpan) && rowSpan > 1
                  ? { rowSpan }
                  : {}),
                ...(nameOf(cell) === "th" ? { header: true as const } : {}),
              },
            ];
          }),
      );

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
      builder.table(readTable(element));
      return;
    }
    if (vocabulary.headings.has(name) && !holdsBlocks(element)) {
      countInlineUnknowns(element);
      builder.heading(readInlines(element));
      return;
    }
    const declared = vocabulary.paragraphs[name];
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
