/**
 * Reader for the decision XML the data-protection authority's portal serves.
 *
 * The portal stores each decision as one structured document: a root naming
 * the decision form and its file mark, then branches of numbered units. The
 * first branch carries no title and holds the operative part; the following
 * branch is titled (`Uzasadnienie`) and holds the reasons. Every unit states
 * its own marker (`1` with suffix `.`, `a` with `)`), its own text, and the
 * units nested under it. Footnotes are printed once at the end and referenced
 * inline by bookmark.
 *
 * Structure is read from those elements only; nothing is inferred from the
 * wording.
 */

import { Result } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isCDATA, isTag, isText } from "domhandler";

import type {
  Block,
  DocumentAst,
  HeadingLevel,
  Inline,
  ParagraphBlock,
  ParagraphListDepth,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";

import { ParseXmlError } from "@/api/lib/errors/tagged-errors";
import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/lib/legal-search/parsers/validate-ast";

import { appendTextInline, inlinesToPlainText } from "./shared-inlines";

/** Publisher recorded on the AST. */
const PL_UODO_SOURCE_SYSTEM = "orzeczenia.uodo.gov.pl";

export type ParsePlUodoDecisionInput = {
  xml: string;
  documentId: string;
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
};

export type ParsePlUodoDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
  validationIssues: string[];
  /** Unexpected element names, or #text/#cdata for stray text nodes. */
  unmappedMarkup: string[];
};

/** Unit types that print a marker and nest as an enumeration. */
const ENUMERATED_UNIT_TYPES = new Set([
  "pass",
  "pint",
  "lett",
  "slet",
  "tiret",
  "cite",
]);

/** How deep an enumeration sits, as far as the reader indents it. */
const listDepthOf = (depth: number): ParagraphListDepth | undefined => {
  if (depth <= 0) {
    return undefined;
  }
  if (depth === 1 || depth === 2 || depth === 3) {
    return depth;
  }
  return 4;
};

const collapse = (text: string): string => text.replace(/\s+/gu, " ");

const childElements = (node: Element, tagName: string): Element[] =>
  node.children.filter(
    (child): child is Element => isTag(child) && child.tagName === tagName,
  );

const ownText = ($: cheerio.CheerioAPI, node: Element | undefined): string =>
  node === undefined ? "" : collapse($(node).text()).trim();

/** The printed marker of a unit: its name and the suffix the source sets. */
const markerOf = ($: cheerio.CheerioAPI, unit: Element): string => {
  const name = childElements(unit, "xName").at(0);
  const text = ownText($, name);
  if (text === "") {
    return "";
  }
  return `${text}${name?.attribs["xSffx"] ?? ""}`;
};

/** Trim the outer edges of a paragraph's inline run, and nothing inside. */
const trimInlines = (inlines: Inline[]): Inline[] => {
  const first = inlines.at(0);
  if (first?.type === "text") {
    first.text = first.text.trimStart();
  }
  const last = inlines.at(-1);
  if (last?.type === "text") {
    last.text = last.text.trimEnd();
  }
  return inlines.filter(
    (inline) => inline.type !== "text" || inline.text !== "",
  );
};

type ParseState = {
  $: cheerio.CheerioAPI;
  blocks: Block[];
  /** Footnote bookmark to the label the source prints for it. */
  glossLabels: Map<string, string>;
  counter: number;
  unmapped: Set<string>;
};

const nextId = (state: ParseState): number => {
  state.counter += 1;
  return state.counter;
};

/** The inline run of one `xText`, with links and footnote marks kept. */
const inlinesOf = (state: ParseState, node: AnyNode): Inline[] => {
  const inlines: Inline[] = [];
  const walk = (current: AnyNode, target: Inline[]): void => {
    if (isText(current)) {
      appendTextInline(target, collapse(current.data));
      return;
    }
    if (!isTag(current)) {
      if (isCDATA(current)) {
        for (const child of current.children) {
          walk(child, target);
        }
      }
      return;
    }
    switch (current.tagName) {
      case "xLexLink": {
        const children: Inline[] = [];
        for (const child of current.children) {
          walk(child, children);
        }
        const cite = collapse(inlinesToPlainText(children)).trim();
        if (cite === "") {
          return;
        }
        target.push({ type: "citation", cite, children });
        return;
      }
      case "xCx": {
        // A quoted term or passage, which the portal sets in italics.
        const children: Inline[] = [];
        for (const child of current.children) {
          walk(child, children);
        }
        if (children.length > 0) {
          target.push({ type: "italic", children });
        }
        return;
      }
      case "xGlossRef": {
        const label = state.glossLabels.get(current.attribs["xRef"] ?? "");
        if (label !== undefined) {
          target.push({
            type: "superscript",
            children: [{ type: "text", text: label }],
          });
        }
        return;
      }
      default: {
        state.unmapped.add(current.tagName);
        for (const child of current.children) {
          walk(child, target);
        }
      }
    }
  };
  if (isTag(node)) {
    for (const child of node.children) {
      walk(child, inlines);
    }
  } else {
    walk(node, inlines);
  }
  return trimInlines(inlines);
};

type ParagraphContext = {
  role: ParagraphRole | undefined;
  listDepth: number;
};

const pushParagraph = (
  state: ParseState,
  inlines: Inline[],
  context: ParagraphContext,
  extra: Partial<ParagraphBlock> = {},
): void => {
  const plainText = inlinesToPlainText(inlines);
  if (plainText.trim() === "") {
    return;
  }
  const index = nextId(state);
  const listDepth = listDepthOf(context.listDepth);
  state.blocks.push({
    id: `b${index}`,
    anchorId: `p-${index}`,
    type: "paragraph",
    ...(context.role === undefined ? {} : { role: context.role }),
    ...(listDepth === undefined ? {} : { listDepth }),
    ...extra,
    inlines,
    plainText,
  });
};

type WalkBlockOptions = {
  state: ParseState;
  node: AnyNode;
  context: ParagraphContext;
  extra?: Partial<ParagraphBlock>;
  depth?: number;
};

/** Unexpected children retain their text where they stand, with a markup report. */
const walkBlock = ({
  state,
  node,
  context,
  extra,
  depth = 0,
}: WalkBlockOptions): void => {
  if (isTag(node)) {
    if (node.tagName !== "xText") {
      state.unmapped.add(node.tagName);
      if (state.$(node).find("xUnit, xText, xBlock").length > 0) {
        walkUnit(state, node, depth, context);
        return;
      }
    }
  } else if (isText(node) || isCDATA(node)) {
    if (inlinesToPlainText(inlinesOf(state, node)).trim() === "") {
      return;
    }
    state.unmapped.add(isText(node) ? "#text" : "#cdata");
  } else {
    return;
  }
  pushParagraph(state, inlinesOf(state, node), context, extra);
};

const pushHeading = (
  state: ParseState,
  text: string,
  level: HeadingLevel,
  role: "decision-title" | "section-heading",
): void => {
  if (text === "") {
    return;
  }
  const index = nextId(state);
  state.blocks.push({
    id: `b${index}`,
    anchorId: `h-${index}`,
    type: "heading",
    level,
    role,
    inlines: [{ type: "text", text }],
    plainText: text,
  });
};

const headingLevelFor = (depth: number): HeadingLevel => {
  const level = Math.min(2 + depth, 6);
  switch (level) {
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 5;
    default:
      return 6;
  }
};

/**
 * One unit: its heading where it prints a title, its texts as paragraphs
 * with the marker opening the first, and the units nested under it.
 */
const walkUnit = (
  state: ParseState,
  unit: Element,
  depth: number,
  context: ParagraphContext,
): void => {
  const { $ } = state;
  const type = unit.attribs["xType"] ?? "";
  const enumerated = ENUMERATED_UNIT_TYPES.has(type);
  const marker = markerOf($, unit);
  const nameNode = childElements(unit, "xName").at(0);
  const titleNode = childElements(unit, "xTitle").at(0);
  const title = ownText($, titleNode);
  const unitContext: ParagraphContext = {
    role: type === "cite" ? "quote" : context.role,
    listDepth: enumerated ? context.listDepth + 1 : context.listDepth,
  };

  if (title !== "") {
    pushHeading(
      state,
      marker === "" ? title : `${marker} ${title}`,
      headingLevelFor(depth),
      "section-heading",
    );
  }

  // The marker belongs to the unit's first text, as the portal prints it; a
  // titled unit already printed it in its heading. A quotation's marker is
  // its opening mark, which sits against the text it opens.
  const opening = type === "cite" ? marker : `${marker} `;
  let pendingMarker = title === "" && marker !== "" ? opening : "";
  const flushPendingMarker = (): void => {
    if (pendingMarker === "") {
      return;
    }
    const inlines: Inline[] = [];
    appendTextInline(inlines, pendingMarker);
    pendingMarker = "";
    pushParagraph(state, inlines, unitContext);
  };
  for (const child of unit.children) {
    if (!isTag(child)) {
      if (inlinesToPlainText(inlinesOf(state, child)).trim() !== "") {
        flushPendingMarker();
      }
      walkBlock({ state, node: child, context: unitContext, depth: depth + 1 });
      continue;
    }
    if (child.tagName === "xText") {
      const inlines = inlinesOf(state, child);
      if (inlinesToPlainText(inlines).trim() === "") {
        continue;
      }
      if (pendingMarker !== "") {
        const opened: Inline[] = [];
        appendTextInline(opened, pendingMarker);
        for (const inline of inlines) {
          if (inline.type === "text") {
            appendTextInline(opened, inline.text);
          } else {
            opened.push(inline);
          }
        }
        pendingMarker = "";
        pushParagraph(state, opened, unitContext);
      } else {
        pushParagraph(state, inlines, unitContext);
      }
      continue;
    }
    if (child === nameNode || child === titleNode) {
      continue;
    }
    // Nested units keep their structure; unknown elements become paragraphs.
    if (child.tagName === "xUnit") {
      flushPendingMarker();
      walkUnit(state, child, depth + 1, unitContext);
    } else {
      if ($(child).text().trim() !== "") {
        flushPendingMarker();
      }
      walkBlock({ state, node: child, context: unitContext, depth: depth + 1 });
    }
  }
  flushPendingMarker();
};

/**
 * The branches of the decision. The one without a title is the operative
 * part, which is what the reader sets as the holding; a titled branch is the
 * reasons, read as body text.
 */
const walkBranches = (state: ParseState, block: Element): void => {
  for (const branch of block.children) {
    if (isTag(branch) && branch.tagName === "xUnit") {
      const titled = ownText(state.$, childElements(branch, "xTitle").at(0));
      walkUnit(state, branch, 0, {
        role: titled === "" ? "holding" : undefined,
        listDepth: 0,
      });
      continue;
    }
    if (isTag(branch) && branch.tagName === "xText") {
      state.unmapped.add(branch.tagName);
    }
    walkBlock({
      state,
      node: branch,
      context: { role: undefined, listDepth: 0 },
    });
  }
};

const glossLabelsOf = (
  $: cheerio.CheerioAPI,
  root: Element,
): Map<string, string> => {
  const labels = new Map<string, string>();
  $(root)
    .find("xGloss")
    .each((_, gloss) => {
      const bookmark = gloss.attribs["xBookmark"];
      const label = collapse(gloss.attribs["xID"] ?? "").trim();
      if (bookmark !== undefined && label !== "") {
        labels.set(bookmark, label);
      }
    });
  return labels;
};

const walkGlosses = (state: ParseState, root: Element): void => {
  for (const glosses of childElements(root, "xGlosses")) {
    for (const gloss of glosses.children) {
      if (!isTag(gloss) || gloss.tagName !== "xGloss") {
        if (isTag(gloss)) {
          state.unmapped.add(gloss.tagName);
        }
        walkBlock({
          state,
          node: gloss,
          context: { role: undefined, listDepth: 0 },
        });
        continue;
      }
      const label = collapse(gloss.attribs["xID"] ?? "").trim();
      const bookmark = gloss.attribs["xBookmark"];
      for (const text of gloss.children) {
        walkBlock({
          state,
          node: text,
          context: { role: undefined, listDepth: 0 },
          extra:
            label === ""
              ? {}
              : {
                  note: {
                    type: "footnote",
                    label,
                    ...(bookmark === undefined ? {} : { noteId: bookmark }),
                  },
                },
        });
      }
    }
  }
};

/**
 * Every text the source prints, read straight off the elements rather than
 * through the walk above, so the validator measures the walk against the
 * source and not against itself.
 */
const sourceTextsOf = ($: cheerio.CheerioAPI, root: Element): string[] => {
  const texts: string[] = [];
  const walk = (node: AnyNode): void => {
    if (isText(node)) {
      const text = collapse(node.data).trim();
      if (text !== "") {
        texts.push(text);
      }
      return;
    }
    if (isTag(node)) {
      if (["xText", "xTitle", "xName"].includes(node.tagName)) {
        const text = ownText($, node);
        if (text !== "") {
          texts.push(text);
        }
        return;
      }
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    if (isCDATA(node)) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(root);
  return texts;
};

/** What the validator measures a parse against, read from the XML alone. */
export const plUodoSourceTexts = (xml: string): string[] => {
  const $ = cheerio.load(xml, { xml: true });
  const root = $("xPart").get(0);
  return root === undefined ? [] : sourceTextsOf($, root);
};

export const parsePlUodoDecisionXml = (
  input: ParsePlUodoDecisionInput,
): Result<ParsePlUodoDecisionOutput, ParseXmlError> => {
  const $ = cheerio.load(input.xml, { xml: true });
  const root = $("xPart").get(0);
  if (root === undefined) {
    return Result.err(
      new ParseXmlError({
        message: "the decision XML has no xPart root",
        cause: undefined,
      }),
    );
  }

  const state: ParseState = {
    $,
    blocks: [],
    glossLabels: glossLabelsOf($, root),
    counter: 0,
    unmapped: new Set(),
  };

  for (const child of root.children) {
    if (!isTag(child)) {
      walkBlock({
        state,
        node: child,
        context: { role: undefined, listDepth: 0 },
      });
      continue;
    }
    switch (child.tagName) {
      case "xName": {
        pushHeading(state, ownText($, child), 1, "decision-title");
        break;
      }
      case "xTitle": {
        const text = ownText($, child);
        if (text !== "") {
          pushParagraph(state, [{ type: "text", text }], {
            role: "case-number",
            listDepth: 0,
          });
        }
        break;
      }
      case "xBlock": {
        walkBranches(state, child);
        break;
      }
      // Read once, after the body, where the portal prints them.
      case "xGlosses": {
        break;
      }
      // A container this reader has no rule for: its texts are read as plain
      // paragraphs in place rather than dropped.
      default: {
        state.unmapped.add(child.tagName);
        walkBlock({
          state,
          node: child,
          context: { role: undefined, listDepth: 0 },
        });
        break;
      }
    }
  }
  walkGlosses(state, root);

  if (state.blocks.length === 0) {
    return Result.err(
      new ParseXmlError({
        message: "the decision XML produced no document blocks",
        cause: undefined,
      }),
    );
  }

  const validation = validateAndLog(
    {
      parser: "pl-uodo",
      caseNumber: input.caseNumber,
      language: "pl",
      url: input.sourceUrl,
    },
    buildValidationHtml(sourceTextsOf($, root)),
    state.blocks,
  );
  // Text the source prints that the document does not hold is a failed
  // parse, not a shorter decision: the adapter keeps the body verbatim and
  // stores the row without a document, so nothing incomplete is published
  // and a parser fix replays it.
  if (!validation.ok) {
    return Result.err(
      new ParseXmlError({
        message: `the parse lost source text: ${validation.issues
          .map((issue) => issue.code)
          .join(", ")}`,
        cause: undefined,
      }),
    );
  }

  return Result.ok({
    documentAst: {
      version: 1,
      source: {
        system: PL_UODO_SOURCE_SYSTEM,
        documentId: input.documentId,
        webUrl: input.sourceUrl ?? "",
        printUrl: "",
      },
      metadata: {
        caseNumber: input.caseNumber,
        ecli: null,
        court: input.court,
        decisionDate: input.decisionDate ?? null,
        decisionType: input.decisionType ?? null,
        keywords: [],
        statutes: [],
      },
      blocks: state.blocks,
    },
    fulltext: state.blocks.map((block) => block.plainText).join("\n\n"),
    validationIssues: validation.issues.map((issue) => issue.code),
    unmappedMarkup: [...state.unmapped],
  });
};
