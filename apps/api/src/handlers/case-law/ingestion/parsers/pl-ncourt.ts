/**
 * The document the common courts' judgments API serves, read.
 *
 * `/judgement/content` answers with the court's own XML (`xPart`): a tree of
 * units (`xUnit`) holding paragraphs (`xText`), with inline marks for
 * anonymized spans (`xAnon`), statute links (`xLexLink`), emphasis, tables
 * (`xRows`) and lists (`xEnum`). The same endpoint renders it as HTML on
 * request; that rendering drops the root's attributes and folds each statute
 * link's fields into one title string, so the XML is what is fetched and
 * kept, and the HTML the Polish decision parser reads is rendered from it
 * here.
 *
 * The rendering follows the publisher's own, block for block: a titled unit
 * is a section under its heading, a numbered one a paragraph opening with its
 * number, a list a definition list of bullet and item, an anonymized span the
 * class the parser already reads as anonymized. A tag with no rule here keeps
 * its text and is reported, so a new mark costs a warning rather than a
 * sentence.
 */

import { panic } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isCDATA, isTag, isText } from "domhandler";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/lib/legal-search/parsers/validate-ast";
import type {
  ValidationResult,
  ValidationSubject,
} from "@/api/lib/legal-search/parsers/validate-ast";

import { ANONYMIZED_CLASS } from "./shared-inlines";

/** The statute a `xLexLink` names, as the link states it. */
type PlNcourtLegalReference = {
  /** The words the judgment links. */
  text: string;
  /** `xArt`: the provisions, `;`-separated as printed. */
  articles: string;
  /** `xIsapId`: the act's id in the Sejm's legal database. */
  isapId: string;
  /** `xTitle`: the act's title. */
  title: string;
  /** `xAddress`: the journal it was promulgated in. */
  address: string;
};

export type PlNcourtContent = {
  /** Every attribute on the root, verbatim, keyed as printed. */
  attributes: Readonly<Record<string, string>>;
  /** The root's own name for the document ("Wyrok+Uzasadnienie"). */
  title: string | undefined;
  /** The document rendered as HTML for the Polish decision parser. */
  html: string;
  /** Every distinct statute link, in document order. */
  legalReferences: PlNcourtLegalReference[];
  /** Unexpected element names, or #text/#cdata for stray text, each once. */
  unmappedMarkup: string[];
  /**
   * The text of every paragraph, title and unit name, read off the XML
   * itself: what the parsed document is measured against, so a rendering
   * that loses text cannot also be what vouches for it.
   */
  sourceParagraphs: string[];
  /** XML text with rendered inline breaks, used only by the word comparison. */
  comparisonParagraphs: string[];
};

const ISAP_DETAILS_URL = "https://isap.sejm.gov.pl/DetailsServlet?id=";

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Inline marks and the HTML each renders as. */
const INLINE_TAGS = {
  xBx: "strong",
  xIx: "em",
  xUx: "u",
  xSUBx: "sub",
} as const satisfies Record<string, string>;

const isInlineTag = (name: string): name is keyof typeof INLINE_TAGS =>
  Object.hasOwn(INLINE_TAGS, name);

/** Layout the rendering has no use for; skipped whole, not reported. */
const LAYOUT_TAGS = new Set(["xCOLGROUPx", "xCOLx"]);

type RenderState = {
  legalReferences: PlNcourtLegalReference[];
  seenReferences: Set<string>;
  unmapped: Set<string>;
};

/** The text a node holds, marks and all. */
const textOf = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  return isTag(node) || isCDATA(node) ? node.children.map(textOf).join("") : "";
};

const comparisonTextOf = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  if (isCDATA(node)) {
    return node.children.map(comparisonTextOf).join("");
  }
  if (!isTag(node)) {
    return "";
  }
  if (node.name === "xBRx") {
    return ` ${node.children.map(comparisonTextOf).join("")}`;
  }
  const children = node.children.map(comparisonTextOf).join("");
  return node.name === "xSUPx" ? ` ${children}` : children;
};

const attributeOf = (element: Element, name: string): string =>
  element.attribs[name]?.trim() ?? "";

const renderInline = (node: AnyNode, state: RenderState): string => {
  if (isText(node)) {
    return escapeHtml(node.data);
  }
  if (isCDATA(node)) {
    return node.children.map((child) => renderInline(child, state)).join("");
  }
  if (!isTag(node)) {
    return "";
  }
  const children = (): string =>
    node.children.map((child) => renderInline(child, state)).join("");
  const { name } = node;
  if (name === "xAnon") {
    return `<span class="${ANONYMIZED_CLASS}">${children()}</span>`;
  }
  if (name === "xBRx") {
    return `<br/>${children()}`;
  }
  if (name === "xLexLink") {
    const reference: PlNcourtLegalReference = {
      text: textOf(node).trim(),
      articles: attributeOf(node, "xArt"),
      isapId: attributeOf(node, "xIsapId"),
      title: attributeOf(node, "xTitle"),
      address: attributeOf(node, "xAddress"),
    };
    const key = JSON.stringify(reference);
    if (!state.seenReferences.has(key)) {
      state.seenReferences.add(key);
      state.legalReferences.push(reference);
    }
    const href =
      reference.isapId.length === 0
        ? ""
        : ` href="${escapeHtml(`${ISAP_DETAILS_URL}${encodeURIComponent(reference.isapId)}`)}"`;
    return `<a${href}>${children()}</a>`;
  }
  if (name === "xSUPx") {
    // Set apart as the publisher's own rendering sets it: "art. 353 1", not
    // "art. 3531", which is another article.
    return `<sup> ${children()}</sup>`;
  }
  if (isInlineTag(name)) {
    const tag = INLINE_TAGS[name];
    return `<${tag}>${children()}</${tag}>`;
  }
  state.unmapped.add(name);
  return children();
};

const renderInlines = (element: Element, state: RenderState): string =>
  element.children.map((child) => renderInline(child, state)).join("");

/** A unit's own name with its suffix: "1" and "." make "1.". */
const unitLabel = (element: Element | undefined): string => {
  if (element === undefined) {
    return "";
  }
  const name = textOf(element).trim();
  return `${name}${attributeOf(element, "xSffx")}`;
};

const childElements = (element: Element): Element[] =>
  element.children.filter((child): child is Element => isTag(child));

const isEmptyLayoutElement = (element: Element): boolean =>
  LAYOUT_TAGS.has(element.name) && textOf(element).trim().length === 0;

/**
 * A table's or a list's children in document order: each run of its items
 * rendered together by `renderRun`, and any other child as a block of its
 * own where it stands. The court's editor can leave paragraphs directly in a
 * table or a list, outside every row or item; they are the judgment's text
 * all the same, and a rendering that kept only the items dropped them
 * without a word.
 */
type ItemRuns = {
  /** The container's own item: `xRow` in a table, `xEnumElem` in a list. */
  item: string;
  renderRun: (items: Element[]) => string;
  /** Children with nothing to render in place. */
  skip: (child: Element) => boolean;
};

const renderItemRuns = (
  element: Element,
  state: RenderState,
  { item, renderRun, skip }: ItemRuns,
): string => {
  const parts: string[] = [];
  let run: Element[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      parts.push(renderRun(run));
      run = [];
    }
  };
  for (const child of element.children) {
    if (isTag(child) && child.name === item) {
      run.push(child);
      continue;
    }
    if (isTag(child) ? skip(child) : textOf(child).trim().length === 0) {
      continue;
    }
    flush();
    parts.push(renderBlock(child, state));
  }
  flush();
  return parts.join("\n");
};

const renderTable = (element: Element, state: RenderState): string =>
  renderItemRuns(element, state, {
    item: "xRow",
    renderRun: (rows) =>
      `<table>${rows
        .map((row) => {
          // A paragraph straight in a row, outside its cells, is a cell of
          // its own rather than lost.
          const cells = row.children
            .filter((cell) =>
              isTag(cell)
                ? !isEmptyLayoutElement(cell)
                : textOf(cell).trim().length > 0,
            )
            .map(
              (cell) =>
                `<td>${isTag(cell) && cell.name === "xClmn" ? renderBlocks(cell, state) : renderBlock(cell, state)}</td>`,
            )
            .join("\n");
          return `<tr>${cells}</tr>`;
        })
        .join("\n")}</table>`,
    skip: isEmptyLayoutElement,
  });

const renderList = (element: Element, state: RenderState): string => {
  const bullet = childElements(element).find(
    (child) => child.name === "xBullet",
  );
  const marker = bullet === undefined ? "" : escapeHtml(textOf(bullet).trim());
  // A term per item for the bullet and the item's paragraphs as its
  // definition, as the publisher renders a list.
  return renderItemRuns(element, state, {
    item: "xEnumElem",
    renderRun: (items) =>
      `<dl>${items
        .map(
          (item) => `<dt>${marker}</dt>\n<dd>${renderBlocks(item, state)}</dd>`,
        )
        .join("\n")}</dl>`,
    skip: (child) => child === bullet || isEmptyLayoutElement(child),
  });
};

const renderUnit = (element: Element, state: RenderState): string => {
  const name = childElements(element).find((child) => child.name === "xName");
  const rest = element.children.filter(
    (child) =>
      child !== name && (isTag(child) || textOf(child).trim().length > 0),
  );

  if (element.attribs["xIsTitle"] === "true") {
    const heading =
      name === undefined ? "" : `<h2>${escapeHtml(textOf(name).trim())}</h2>`;
    return `<div>${heading}${rest.map((child) => renderBlock(child, state)).join("\n")}</div>`;
  }
  // A numbered point: its number opens its first paragraph, as printed.
  const label = unitLabel(name);
  const [first, ...others] = rest;
  if (
    first !== undefined &&
    isTag(first) &&
    first.name === "xText" &&
    label.length > 0
  ) {
    return `<p>${escapeHtml(label)} ${renderInlines(first, state)}</p>${others
      .map((child) => renderBlock(child, state))
      .join("\n")}`;
  }
  const opening = label.length > 0 ? `<p>${escapeHtml(label)}</p>` : "";
  return `${opening}${rest.map((child) => renderBlock(child, state)).join("\n")}`;
};

const STRUCTURAL_TAGS = new Set([
  "xText",
  "xTitle",
  "xUnit",
  "xBlock",
  "xRows",
  "xEnum",
]);

const hasStructuralDescendant = (element: Element): boolean =>
  element.children.some(
    (child) =>
      isTag(child) &&
      (STRUCTURAL_TAGS.has(child.name) || hasStructuralDescendant(child)),
  );

const renderBlock = (element: AnyNode, state: RenderState): string => {
  if (!isTag(element)) {
    if (
      (!isText(element) && !isCDATA(element)) ||
      textOf(element).trim().length === 0
    ) {
      return "";
    }
    state.unmapped.add(isText(element) ? "#text" : "#cdata");
    return `<p>${renderInline(element, state)}</p>`;
  }
  switch (element.name) {
    case "xText":
      return `<p>${renderInlines(element, state)}</p>`;
    case "xTitle":
      return `<h5>${renderInlines(element, state)}</h5>`;
    case "xUnit":
      return renderUnit(element, state);
    case "xRows":
      return renderTable(element, state);
    case "xEnum":
      return renderList(element, state);
    case "xBlock":
      return renderBlocks(element, state);
    default: {
      if (LAYOUT_TAGS.has(element.name)) {
        if (isEmptyLayoutElement(element)) {
          return "";
        }
        state.unmapped.add(element.name);
        return renderBlocks(element, state);
      }
      state.unmapped.add(element.name);
      if (hasStructuralDescendant(element)) {
        return renderBlocks(element, state);
      }
      return `<p>${renderInlines(element, state)}</p>`;
    }
  }
};

const renderBlocks = (element: Element, state: RenderState): string =>
  element.children
    .filter((child) => isTag(child) || textOf(child).trim().length > 0)
    .map((child) => renderBlock(child, state))
    .join("\n");

/**
 * Read one document, or `null` for anything that is not one: the API's
 * `<error>` answer, an HTML page, an empty body.
 */
export const readPlNcourtContent = (xml: string): PlNcourtContent | null => {
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first().get(0);
  if (root === undefined || !isTag(root) || root.name !== "xPart") {
    return null;
  }
  const state: RenderState = {
    legalReferences: [],
    seenReferences: new Set(),
    unmapped: new Set(),
  };
  const children = childElements(root);
  const name = children.find((child) => child.name === "xName");
  const html = root.children
    .filter(
      (child) =>
        child !== name && (isTag(child) || textOf(child).trim().length > 0),
    )
    .map((child) => renderBlock(child, state))
    .join("\n");
  const title =
    name === undefined ? undefined : textOf(name).trim() || undefined;
  const paragraphs = sourceParagraphsOf(root);
  return {
    attributes: { ...root.attribs },
    title,
    html,
    legalReferences: state.legalReferences,
    unmappedMarkup: [...state.unmapped],
    sourceParagraphs: paragraphs.source,
    comparisonParagraphs: paragraphs.comparison,
  };
};

/** Elements whose text is a paragraph of the document as the court wrote it. */
const TEXT_ELEMENTS = new Set(["xText", "xTitle", "xName"]);

const sourceParagraphsOf = (root: Element) => {
  const source: string[] = [];
  const comparison: string[] = [];
  const push = (node: AnyNode, text: string): void => {
    if (text.length > 0) {
      source.push(text);
      comparison.push(comparisonTextOf(node).replace(/\s+/gu, " ").trim());
    }
  };
  const walk = (node: AnyNode): void => {
    if (isTag(node)) {
      if (TEXT_ELEMENTS.has(node.name)) {
        // Only the root's own name labels the document rather than its text.
        push(
          node,
          node.parent === root && node.name === "xName"
            ? ""
            : textOf(node).replace(/\s+/gu, " ").trim(),
        );
        return;
      }
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    if (isText(node) || isCDATA(node)) {
      push(node, textOf(node).replace(/\s+/gu, " ").trim());
    }
  };
  walk(root);
  return { source, comparison };
};

/**
 * Check a parsed document against the text the XML states, and log what it
 * lost. The parser checks itself against the HTML it was given; that HTML is
 * rendered here, so only the XML can say whether the rendering kept every
 * sentence.
 */
export const validatePlNcourtDocument = (
  subject: ValidationSubject,
  content: PlNcourtContent,
  blocks: Block[],
): ValidationResult => {
  const seen = new Set<string>();
  const comparisonParts: string[] = [];
  for (const [index, source] of content.sourceParagraphs.entries()) {
    if (seen.has(source)) {
      continue;
    }
    seen.add(source);
    comparisonParts.push(
      content.comparisonParagraphs[index] ??
        panic("Missing pl-ncourt comparison paragraph"),
    );
  }
  return validateAndLog(
    subject,
    buildValidationHtml(content.sourceParagraphs.map(escapeHtml)),
    blocks,
    { wordComparisonText: comparisonParts.join(" ") },
  );
};
