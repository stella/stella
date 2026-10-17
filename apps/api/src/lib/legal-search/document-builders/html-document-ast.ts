/**
 * A `DocumentAst` from a publisher's HTML page, for any guidance source.
 *
 * The adapter knows the publisher's page and names the element holding the
 * text (`contentRoot`); everything inside it is read by HTML semantics alone,
 * never by publisher class names: headings are `h1`–`h6`, blocks are the
 * elements HTML lays out as blocks, and a footnote is whatever an in-page
 * marker link (`<a href="#fn3">3</a>`, Word's `[3]`) points at. Notes are
 * read where they are printed and set after the body, each under the mark
 * the body printed for it.
 */

import { Result } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

import { hasInlineChildren, plainTextOf } from "@stll/legal-ast/document-ast";
import type {
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
  "header",
  "footer",
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

/** A footnote mark as printed in a link: `3`, `[3]`, `(3)`, `*`. */
const NOTE_MARK = /^[[(]?(\*{1,3}|\d{1,3})[\])]?$/u;

const isHeadingTag = (tag: string): tag is keyof typeof HEADING_LEVELS =>
  Object.hasOwn(HEADING_LEVELS, tag);

const tagOf = (node: AnyNode): string | null =>
  isTag(node) ? node.tagName.toLowerCase() : null;

const isSkipped = (tag: string): boolean =>
  SKIPPED_TAGS.has(tag) || isExcludedHtmlTag(tag);

const markOf = (text: string): string | null =>
  NOTE_MARK.exec(text.trim())?.at(1) ?? null;

type Footnotes = {
  /** Footnote container to the mark the body printed for it. */
  labels: Map<Element, string>;
  /** In-page ids a marker link points at, to the footnote's mark. */
  marks: Map<string, string>;
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

/** Every element an in-page fragment can name, by `id` and legacy `<a name>`. */
const fragmentTargets = (
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<Element>,
): Map<string, Element> => {
  const targets = new Map<string, Element>();
  root.find("a[name]").each((_, anchor) => {
    const name = anchor.attribs["name"];
    // A named anchor marks a position; the note is the block around it.
    const block = $(anchor).closest("p, li, div, aside").get(0);
    if (name !== undefined && block !== undefined && isTag(block)) {
      targets.set(name, block);
    }
  });
  root.find("[id]").each((_, element) => {
    const id = element.attribs["id"];
    const block =
      tagOf(element) === "a"
        ? $(element).closest("p, li, div, aside").get(0)
        : element;
    if (id !== undefined && block !== undefined && isTag(block)) {
      targets.set(id, block);
    }
  });
  return targets;
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
  const marks = new Map<string, string>();
  root.find("a[href^='#']").each((_, link) => {
    const fragment = fragmentOf(link.attribs["href"] ?? "");
    const mark = markOf($(link).text());
    const target = targets.get(fragment);
    if (
      mark === null ||
      target === undefined ||
      labels.has(target) ||
      $(link).closest(target).length > 0 ||
      [...labels.keys()].some((note) => $(link).closest(note).length > 0)
    ) {
      return;
    }
    labels.set(target, mark);
    marks.set(fragment, mark);
  });
  return { labels, marks };
};

const noteMarkInline = (mark: string): Inline => ({
  type: "superscript",
  children: [{ type: "text", text: mark }],
});

type ResolveFragmentsOptions = {
  footnotes: Footnotes;
  /** Inside a note, a marker-shaped in-page link is the note's back reference. */
  inNote: boolean;
};

/**
 * In-page links resolved: a marker link becomes its mark in superscript,
 * a note's back reference is dropped (the note carries its mark), and any
 * other in-page link keeps its text without the link, since it navigates
 * the publisher's page rather than the document.
 */
const resolveFragments = (
  inlines: readonly Inline[],
  options: ResolveFragmentsOptions,
): Inline[] => {
  const out: Inline[] = [];
  for (const inline of inlines) {
    if (inline.type === "link" && inline.href.startsWith("#")) {
      const mark = options.footnotes.marks.get(fragmentOf(inline.href));
      if (mark !== undefined && !options.inNote) {
        out.push(noteMarkInline(mark));
      } else if (
        !options.inNote ||
        markOf(plainTextOf(inline.children)) === null
      ) {
        out.push(...resolveFragments(inline.children, options));
      }
      continue;
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
};

type BlockContext = {
  /** Where paragraphs go: the body, or the notes after it. */
  into: "body" | "notes";
  note: ParagraphBlock["note"];
  role: ParagraphBlock["role"];
  listDepth: number;
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

const inlinesOf = (
  state: BuildState,
  nodes: cheerio.Cheerio<AnyNode>,
  context: BlockContext,
): Inline[] =>
  collapseHtmlWhitespace(
    resolveFragments(
      walkInlines(state.$, nodes, {
        sanitizeHref: resolvedHref(state.baseUrl),
      }),
      { footnotes: state.footnotes, inNote: context.into === "notes" },
    ),
  );

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
): void => {
  if (plainTextOf(inlines).trim() === "") {
    return;
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
  if (rows.every((row) => row.every((cell) => cell.plainText === ""))) {
    return;
  }
  state[context.into].push({
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
  });
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
      pushParagraph(state, inlinesOf(state, wrapper, context), context);
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
    };
    if (hasBlockChildren(element)) {
      walkChildren(state, element, noteContext);
    } else {
      pushParagraph(
        state,
        inlinesOf(state, state.$(element), noteContext),
        noteContext,
      );
    }
    return;
  }
  if (isHeadingTag(tag)) {
    const inlines = inlinesOf(state, state.$(element), context);
    const text = plainTextOf(inlines).trim();
    if (text !== "") {
      state.body.push({
        key: headingKeyOf(text),
        block: {
          type: "heading",
          level: HEADING_LEVELS[tag],
          role: "section-heading",
          ...draftText(inlines),
        },
      });
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
    pushParagraph(state, inlinesOf(state, state.$(element), inner), inner);
    return;
  }
  walkChildren(state, element, inner);
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
  const $ = cheerio.load(html);
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
  };
  walkChildren(state, rootElement, {
    into: "body",
    note: undefined,
    role: undefined,
    listDepth: 0,
  });
  return assembleDocumentAst({
    source,
    metadata,
    blocks: [...state.body, ...state.notes],
  });
};
