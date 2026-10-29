/**
 * A `DocumentAst` from a publisher's HTML page, for any guidance source.
 *
 * The adapter knows the publisher's page and names the element holding the
 * text (`contentRoot`); everything inside it is read by HTML semantics alone,
 * never by publisher class names: headings are `h1`–`h6`, blocks are the
 * elements HTML lays out as blocks. A footnote is an explicitly identified
 * note that an in-page marker link (`<a href="#fn3">3</a>`, Word's `[3]`)
 * points at. Notes are read where they are printed and set after the body,
 * each under the mark the body printed for it.
 */

import { panic, Result } from "better-result";
import type * as cheerio from "cheerio/slim";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

import { load } from "@stll/html";
import {
  hasInlineChildren,
  plainTextOf,
  withProjectedPlainText,
} from "@stll/legal-ast/document-ast";
import type {
  Block,
  DocumentAst,
  DocumentAstMetadata,
  DocumentAstSource,
  HeadingLevel,
  Inline,
  ParagraphBlock,
  ParagraphListDepth,
  TableCell,
} from "@stll/legal-ast/document-ast";

import {
  isExcludedHtmlTag,
  ownTableRows,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

import type { BlockKey, KeyedBlock } from "./block-ids";
import {
  assembleDocumentAst,
  DocumentBuildError,
  draftText,
} from "./document-assembly";
import { collapseHtmlWhitespace } from "./html-whitespace";
import { headingKeyOf } from "./section-labels";

/** Page chrome a content root can still contain; none of it is document text. */
const SKIPPED_TAGS = new Set([
  "nav",
  "form",
  "button",
  "noscript",
  "template",
  "svg",
  "iframe",
  "select",
  "input",
  "hr",
]);

const HEADING_LEVELS = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
} as const satisfies Record<string, HeadingLevel>;

/** Elements whose content is one paragraph unless they hold blocks. */
const PARAGRAPH_TAGS = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "pre",
  "figcaption",
  "address",
]);

/** Elements HTML lays out as blocks: a run of inline content ends at one. */
const BLOCK_TAGS = new Set([
  ...Object.keys(HEADING_LEVELS),
  ...PARAGRAPH_TAGS,
  ...SKIPPED_TAGS,
  "div",
  "header",
  "footer",
  "section",
  "article",
  "main",
  "aside",
  "blockquote",
  "ul",
  "ol",
  "dl",
  "table",
  "figure",
]);

const LIST_TAGS = new Set(["ul", "ol"]);
const MAX_LIST_DEPTH = 4;

/** A footnote mark as printed in a link: `3`, `[3]`, `(3)`, `*`, or `a`. */
const NOTE_MARK = /^(?:([*†‡§a-z])|\[(\d{1,3})\]|\((\d{1,3})\)|(\d{1,3}))$/u;

const isHeadingTag = (tag: string): tag is keyof typeof HEADING_LEVELS =>
  Object.hasOwn(HEADING_LEVELS, tag);

const tagOf = (node: AnyNode): string | null =>
  isTag(node) ? node.tagName.toLowerCase() : null;

const isSkipped = (tag: string): boolean =>
  SKIPPED_TAGS.has(tag) || isExcludedHtmlTag(tag);

const markOf = (text: string): string | null =>
  NOTE_MARK.exec(text.trim())?.slice(1).find(Boolean) ?? null;

type Footnotes = {
  /** Footnote container to the mark the body printed for it. */
  labels: Map<Element, string>;
  /** Positively identified notes, by publisher fragment. */
  notes: Map<string, { mark: string; target: Element }>;
  /** Publisher ids on reference markers, associated with their note. */
  references: Map<string, Element>;
};

/**
 * An in-page link's fragment, decoded. A malformed escape is publisher
 * input, not a reason to fail the document: it is compared as printed.
 */
const fragmentOf = (href: string): string => {
  const raw = href.slice(1);
  const decoded = Result.try(() => decodeURIComponent(raw));
  return decoded.status === "ok" ? decoded.value : raw;
};

type FragmentTarget = {
  element: Element;
  block: Element;
};

/** Keep publisher evidence on the target and emit its owning content block. */
const fragmentTargets = (
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<Element>,
): Map<string, FragmentTarget> => {
  const targets = new Map<string, FragmentTarget>();
  const selector = [...BLOCK_TAGS].join(",");
  const register = (fragment: string | undefined, element: Element): void => {
    const block = $(element).closest(selector).get(0);
    if (fragment !== undefined && block !== undefined && isTag(block)) {
      targets.set(fragment, { element, block });
    }
  };
  root.find("a[name]").each((_, anchor) => {
    register(anchor.attribs["name"], anchor);
  });
  root.find("[id]").each((_, element) => {
    register(element.attribs["id"], element);
  });
  return targets;
};

const NOTE_ROLE = new Set([
  "doc-footnote",
  "doc-endnote",
  "doc-footnotes",
  "doc-endnotes",
]);
const NOTE_CONTAINER_NAME = /^(?:footnotes?|endnotes?|notes)$/iu;
const NOTE_TARGET_ID = /^_?(?:fn|ftn|footnote)(?:[-_:]?\d|%)/iu;

/** Positive publisher annotations that identify a fragment target as a note. */
const isNoteTarget = ($: cheerio.CheerioAPI, target: Element): boolean => {
  if (isHeadingTag(target.tagName.toLowerCase())) {
    return false;
  }
  let element: Element | undefined = target;
  while (element !== undefined) {
    const role = element.attribs["role"];
    const classNames = element.attribs["class"];
    const names = [
      element.attribs["id"],
      element.attribs["name"],
      ...(classNames === undefined ? [] : classNames.split(/\s+/u)),
    ];
    if (
      (role !== undefined && NOTE_ROLE.has(role.toLowerCase())) ||
      names.some(
        (name) =>
          name !== undefined &&
          (NOTE_CONTAINER_NAME.test(name) || NOTE_TARGET_ID.test(name)),
      )
    ) {
      return true;
    }
    const parent: AnyNode | undefined = $(element).parent().get(0);
    element = parent !== undefined && isTag(parent) ? parent : undefined;
  }
  return false;
};

/**
 * Every footnote a marker link in the body points at. A link counts only
 * outside every note found so far, and never when its target contains it: a
 * note's back reference to its marker is a marker-shaped link too, and must
 * not turn the body paragraph it points at into a note.
 */
const findFootnotes = (
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<Element>,
): Footnotes => {
  const targets = fragmentTargets($, root);
  const labels = new Map<Element, string>();
  const notes = new Map<string, { mark: string; target: Element }>();
  const references = new Map<string, Element>();
  root.find("a[href^='#']").each((_, link) => {
    const fragment = fragmentOf(link.attribs["href"] ?? "");
    const mark = markOf($(link).text());
    const fragmentTarget = targets.get(fragment);
    const target = fragmentTarget?.block;
    if (
      mark === null ||
      fragmentTarget === undefined ||
      target === undefined ||
      isHeadingTag(target.tagName.toLowerCase()) ||
      !isNoteTarget($, fragmentTarget.element) ||
      $(link).closest(target).length > 0 ||
      [...labels.keys()].some((note) => $(link).closest(note).length > 0)
    ) {
      return;
    }
    if (!labels.has(target)) {
      labels.set(target, mark);
    }
    notes.set(fragment, { mark, target });
    for (const reference of [link.attribs["id"], link.attribs["name"]]) {
      if (reference !== undefined) {
        references.set(reference, target);
      }
    }
  });
  return { labels, notes, references };
};

const noteMarkInline = (mark: string): Inline => ({
  type: "superscript",
  children: [{ type: "text", text: mark }],
});

type FragmentLinkEvidence = {
  href: string;
  note: Element | undefined;
  explicitBacklink: boolean;
};

type FragmentLinkResolution =
  | { type: "noteReference"; mark: string }
  | { type: "noteBacklink" }
  | { type: "crossReference"; anchorId: string }
  | { type: "unresolved" };

const BACKLINK_ROLES = new Set(["doc-backlink"]);

const classifyFragmentLink = (
  evidence: FragmentLinkEvidence,
  visibleText: string,
  footnotes: Footnotes,
  anchorByPublisherId: ReadonlyMap<string, string>,
): FragmentLinkResolution => {
  const fragment = fragmentOf(evidence.href);
  const note = footnotes.notes.get(fragment);
  const visibleMark = markOf(visibleText);
  if (note !== undefined && visibleMark !== null) {
    return { type: "noteReference", mark: visibleMark };
  }
  if (
    evidence.note !== undefined &&
    (evidence.explicitBacklink ||
      footnotes.references.get(fragment) === evidence.note)
  ) {
    return { type: "noteBacklink" };
  }
  const anchorId = anchorByPublisherId.get(fragment);
  return anchorId === undefined
    ? { type: "unresolved" }
    : { type: "crossReference", anchorId };
};

type ResolveFragmentsOptions = {
  evidenceByHref: ReadonlyMap<string, FragmentLinkEvidence>;
  footnotes: Footnotes;
  anchorByPublisherId: ReadonlyMap<string, string>;
};

/** The single disposition point for every publisher fragment link. */
const resolveFragments = (
  inlines: readonly Inline[],
  options: ResolveFragmentsOptions,
): Inline[] => {
  const out: Inline[] = [];
  for (const inline of inlines) {
    if (inline.type === "link") {
      const evidence = options.evidenceByHref.get(inline.href);
      if (evidence !== undefined) {
        const resolution = classifyFragmentLink(
          evidence,
          plainTextOf(inline.children),
          options.footnotes,
          options.anchorByPublisherId,
        );
        switch (resolution.type) {
          case "noteReference": {
            out.push(noteMarkInline(resolution.mark));
            break;
          }
          case "noteBacklink": {
            break;
          }
          case "crossReference": {
            out.push({
              ...inline,
              href: `#${resolution.anchorId}`,
              children: resolveFragments(inline.children, options),
            });
            break;
          }
          case "unresolved": {
            out.push(...resolveFragments(inline.children, options));
            break;
          }
          default: {
            resolution satisfies never;
            return panic(
              `Unhandled fragment resolution: ${String(resolution)}`,
            );
          }
        }
        continue;
      }
    }
    if (!hasInlineChildren(inline)) {
      out.push(inline);
      continue;
    }
    const children = resolveFragments(inline.children, options);
    const only = children.at(0);
    // `<sup><a href="#fn1">1</a></sup>` is one mark, not a mark in a mark.
    if (
      inline.type === "superscript" &&
      children.length === 1 &&
      only?.type === "superscript"
    ) {
      out.push(only);
      continue;
    }
    if (children.length > 0) {
      out.push({ ...inline, children });
    }
  }
  return out;
};

type BuildState = {
  $: cheerio.CheerioAPI;
  baseUrl: string;
  footnotes: Footnotes;
  body: KeyedBlock[];
  notes: KeyedBlock[];
  /** Notes read so far; numbers each note's `noteId`, whatever its mark. */
  noteCount: number;
  fragmentEvidence: Map<string, FragmentLinkEvidence>;
  nextFragmentLink: number;
  /** Source elements owned by each drafted block, before ids are assigned. */
  sourceBlocks: Map<Element, KeyedBlock>;
};

type BlockContext = {
  /** Where paragraphs go: the body, or the notes after it. */
  into: "body" | "notes";
  note: ParagraphBlock["note"];
  role: ParagraphBlock["role"];
  listDepth: number;
  noteTarget: Element | undefined;
};

const POSITIONAL: BlockKey = { type: "positional" };

const resolvedHref = (baseUrl: string) => (href: string) => {
  if (href.startsWith("#")) {
    return href;
  }
  return URL.canParse(href, baseUrl)
    ? sanitizeUrl(new URL(href, baseUrl).href)
    : undefined;
};

const prepareFragmentLinks = (
  state: BuildState,
  nodes: cheerio.Cheerio<AnyNode>,
  context: BlockContext,
): void => {
  nodes
    .find("a[href^='#']")
    .addBack("a[href^='#']")
    .each((_, link) => {
      if (!isTag(link)) {
        return;
      }
      const href = link.attribs["href"];
      if (href === undefined) {
        return;
      }
      state.nextFragmentLink += 1;
      const token = `#__stella_fragment_${String(state.nextFragmentLink)}`;
      const role = link.attribs["role"];
      const roles = role === undefined ? [] : role.toLowerCase().split(/\s+/u);
      state.fragmentEvidence.set(token, {
        href,
        note: context.noteTarget,
        explicitBacklink: roles.some((linkRole) =>
          BACKLINK_ROLES.has(linkRole),
        ),
      });
      link.attribs["href"] = token;
    });
};

const inlinesOf = (
  state: BuildState,
  nodes: cheerio.Cheerio<AnyNode>,
  context: BlockContext,
): Inline[] => {
  prepareFragmentLinks(state, nodes, context);
  return collapseHtmlWhitespace(
    walkInlines(state.$, nodes, {
      sanitizeHref: resolvedHref(state.baseUrl),
    }),
  );
};

const listDepthOf = (depth: number): ParagraphListDepth | undefined => {
  const clamped = Math.min(depth, MAX_LIST_DEPTH);
  switch (clamped) {
    case 1:
    case 2:
    case 3:
    case 4:
      return clamped;
    default:
      return undefined;
  }
};

const pushParagraph = (
  state: BuildState,
  inlines: Inline[],
  context: BlockContext,
): KeyedBlock | undefined => {
  if (plainTextOf(inlines).trim() === "") {
    return undefined;
  }
  const listDepth = listDepthOf(context.listDepth);
  const block: KeyedBlock = {
    key:
      context.note === undefined
        ? POSITIONAL
        : { type: "footnote", label: context.note.label },
    block: {
      type: "paragraph",
      ...(context.role === undefined ? {} : { role: context.role }),
      ...(context.note === undefined ? {} : { note: context.note }),
      ...(listDepth === undefined ? {} : { listDepth }),
      ...draftText(inlines),
    },
  };
  state[context.into].push(block);
  return block;
};

const registerSource = (
  state: BuildState,
  nodes: readonly AnyNode[],
  block: KeyedBlock | undefined,
): void => {
  if (block === undefined) {
    return;
  }
  for (const node of nodes) {
    if (!isTag(node)) {
      continue;
    }
    state.sourceBlocks.set(node, block);
    state
      .$(node)
      .find("*")
      .each((_, descendant) => {
        state.sourceBlocks.set(descendant, block);
      });
  }
};

const tableCellOf = (
  state: BuildState,
  cell: Element,
  context: BlockContext,
): TableCell => {
  const colSpan = Number(cell.attribs["colspan"] ?? "1");
  const rowSpan = Number(cell.attribs["rowspan"] ?? "1");
  return {
    ...draftText(inlinesOf(state, state.$(cell), context)),
    ...(Number.isInteger(colSpan) && colSpan > 1 ? { colSpan } : {}),
    ...(Number.isInteger(rowSpan) && rowSpan > 1 ? { rowSpan } : {}),
    ...(tagOf(cell) === "th" ? { header: true } : {}),
  };
};

const pushTable = (
  state: BuildState,
  table: Element,
  context: BlockContext,
): void => {
  const rows = ownTableRows(state.$(table))
    .toArray()
    .map((row) =>
      state
        .$(row)
        .children("td, th")
        .toArray()
        .map((cell) => tableCellOf(state, cell, context)),
    )
    .filter((row) => row.length > 0);
  const hasCells = rows.some((row) =>
    row.some((cell) => cell.plainText !== ""),
  );
  const block: KeyedBlock = {
    key:
      context.note === undefined
        ? POSITIONAL
        : { type: "footnote", label: context.note.label },
    block: {
      type: "table",
      ...(context.note === undefined ? {} : { note: context.note }),
      rows,
      // Rejoined from the cells once the document is assembled.
      plainText: "",
    },
  };
  // Caption markers belong to their paragraph, overriding the table's
  // descendant mapping while retaining publisher order in the output.
  if (hasCells) {
    registerSource(state, [table], block);
  }
  for (const caption of state.$(table).children("caption").toArray()) {
    registerSource(
      state,
      [caption],
      pushParagraph(
        state,
        inlinesOf(state, state.$(caption), context),
        context,
      ),
    );
  }
  if (hasCells) {
    state[context.into].push(block);
  }
};

const hasBlockChildren = (element: Element): boolean =>
  element.children.some((child) => {
    const tag = tagOf(child);
    return tag !== null && BLOCK_TAGS.has(tag);
  });

/**
 * The children of a container, a run of inline content at a time: inline
 * nodes between two blocks are one paragraph, as a browser lays them out.
 */
const walkChildren = (
  state: BuildState,
  element: Element,
  context: BlockContext,
): void => {
  let run: AnyNode[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      const wrapper = state.$("<span></span>").append(state.$(run).clone());
      const block = pushParagraph(
        state,
        inlinesOf(state, wrapper, context),
        context,
      );
      registerSource(state, run, block);
      run = [];
    }
  };
  for (const child of element.children) {
    const tag = tagOf(child);
    if (tag !== null && BLOCK_TAGS.has(tag)) {
      flush();
      if (isTag(child)) {
        walkBlock(state, child, context);
      }
    } else if (tag !== null || isText(child)) {
      run.push(child);
    }
  }
  flush();
};

const walkBlock = (
  state: BuildState,
  element: Element,
  context: BlockContext,
): void => {
  const tag = element.tagName.toLowerCase();
  if (isSkipped(tag)) {
    return;
  }
  const noteMark = state.footnotes.labels.get(element);
  if (noteMark !== undefined && context.into === "body") {
    state.noteCount += 1;
    // Marks repeat (`*`, a numbering restarting per chapter), so the id that
    // groups a note's blocks counts notes instead of reusing the mark.
    const noteContext: BlockContext = {
      into: "notes",
      note: {
        type: "footnote",
        label: noteMark,
        noteId: `note-${String(state.noteCount)}`,
      },
      role: undefined,
      listDepth: 0,
      noteTarget: element,
    };
    if (hasBlockChildren(element)) {
      walkChildren(state, element, noteContext);
    } else {
      const block = pushParagraph(
        state,
        inlinesOf(state, state.$(element), noteContext),
        noteContext,
      );
      registerSource(state, [element], block);
    }
    return;
  }
  if (isHeadingTag(tag)) {
    const inlines = inlinesOf(state, state.$(element), context);
    if (context.into === "notes") {
      registerSource(state, [element], pushParagraph(state, inlines, context));
      return;
    }
    const text = plainTextOf(inlines).trim();
    if (text !== "") {
      const block: KeyedBlock = {
        key: headingKeyOf(text),
        block: {
          type: "heading",
          level: HEADING_LEVELS[tag],
          role: "section-heading",
          ...draftText(inlines),
        },
      };
      state.body.push(block);
      registerSource(state, [element], block);
    }
    return;
  }
  if (tag === "table") {
    pushTable(state, element, context);
    return;
  }
  const inner: BlockContext = {
    ...context,
    role: tag === "blockquote" ? "quote" : context.role,
    listDepth: LIST_TAGS.has(tag) ? context.listDepth + 1 : context.listDepth,
  };
  if (PARAGRAPH_TAGS.has(tag) && !hasBlockChildren(element)) {
    registerSource(
      state,
      [element],
      pushParagraph(state, inlinesOf(state, state.$(element), inner), inner),
    );
    return;
  }
  walkChildren(state, element, inner);
};

const sourceBlockOf = (
  state: BuildState,
  target: Element,
): KeyedBlock | undefined => {
  let element: Element | undefined = target;
  while (element !== undefined) {
    const block = state.sourceBlocks.get(element);
    if (block !== undefined) {
      return block;
    }
    const parent: AnyNode | undefined = state.$(element).parent().get(0);
    element = parent !== undefined && isTag(parent) ? parent : undefined;
  }
  for (const descendant of state.$(target).find("*").toArray()) {
    const block = state.sourceBlocks.get(descendant);
    if (block !== undefined) {
      return block;
    }
  }
  return undefined;
};

const anchorMapOf = (
  state: BuildState,
  root: cheerio.Cheerio<Element>,
  keyedBlocks: readonly KeyedBlock[],
  blocks: readonly Block[],
): Map<string, string> => {
  const anchorByBlock = new Map(
    keyedBlocks.map((keyed, index) => [keyed, blocks[index]?.anchorId]),
  );
  const anchors = new Map<string, string>();
  root.find("[id], a[name]").each((_, element) => {
    const block = sourceBlockOf(state, element);
    const anchorId = block === undefined ? undefined : anchorByBlock.get(block);
    if (anchorId === undefined) {
      return;
    }
    for (const publisherId of [
      element.attribs["id"],
      element.attribs["name"],
    ]) {
      if (publisherId !== undefined) {
        anchors.set(publisherId, anchorId);
      }
    }
  });
  return anchors;
};

const resolveBlockFragments = (
  block: Block,
  options: ResolveFragmentsOptions,
): Block => {
  switch (block.type) {
    case "heading":
    case "paragraph": {
      return { ...block, inlines: resolveFragments(block.inlines, options) };
    }
    case "table": {
      return {
        ...block,
        rows: block.rows.map((row) =>
          row.map((cell) => ({
            ...cell,
            inlines: resolveFragments(cell.inlines, options),
          })),
        ),
      };
    }
    case "image": {
      return block;
    }
    default: {
      block satisfies never;
      return panic(`Unhandled block: ${String(block)}`);
    }
  }
};

type BuildHtmlDocumentAstOptions = {
  html: string;
  /** CSS selector of the element holding the document text. */
  contentRoot: string;
  /** The URL the page was served from; relative links resolve against it. */
  baseUrl: string;
  source: DocumentAstSource;
  metadata: DocumentAstMetadata;
};

export const buildHtmlDocumentAst = ({
  baseUrl,
  contentRoot,
  html,
  metadata,
  source,
}: BuildHtmlDocumentAstOptions): Result<DocumentAst, DocumentBuildError> => {
  const $ = load(html);
  const rootElement = $(contentRoot).get(0);
  if (rootElement === undefined || !isTag(rootElement)) {
    return Result.err(
      new DocumentBuildError({
        message: `no element matches the content root ${contentRoot}`,
        reason: "no-content-root",
      }),
    );
  }
  const state: BuildState = {
    $,
    baseUrl,
    footnotes: findFootnotes($, $(rootElement)),
    body: [],
    notes: [],
    noteCount: 0,
    fragmentEvidence: new Map(),
    nextFragmentLink: 0,
    sourceBlocks: new Map(),
  };
  walkChildren(state, rootElement, {
    into: "body",
    note: undefined,
    role: undefined,
    listDepth: 0,
    noteTarget: undefined,
  });
  const keyedBlocks = [...state.body, ...state.notes];
  return assembleDocumentAst({
    source,
    metadata,
    blocks: keyedBlocks,
  }).map((ast) => {
    const anchorByPublisherId = anchorMapOf(
      state,
      $(rootElement),
      keyedBlocks,
      ast.blocks,
    );
    return withProjectedPlainText({
      ...ast,
      blocks: ast.blocks.map((block) =>
        resolveBlockFragments(block, {
          evidenceByHref: state.fragmentEvidence,
          footnotes: state.footnotes,
          anchorByPublisherId,
        }),
      ),
    });
  });
};
