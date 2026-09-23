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

import * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

import type { Block } from "@/api/handlers/case-law/document-ast";
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
  /** Element names the rendering has no rule for, each once. */
  unmappedMarkup: string[];
  /**
   * The text of every paragraph, title and unit name, read off the XML
   * itself: what the parsed document is measured against, so a rendering
   * that loses text cannot also be what vouches for it.
   */
  sourceParagraphs: string[];
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
  return isTag(node) ? node.children.map(textOf).join("") : "";
};

const attributeOf = (element: Element, name: string): string =>
  element.attribs[name]?.trim() ?? "";

const renderInline = (node: AnyNode, state: RenderState): string => {
  if (isText(node)) {
    return escapeHtml(node.data);
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
    return "<br/>";
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

const renderTable = (element: Element, state: RenderState): string => {
  const rows = childElements(element)
    .filter((row) => row.name === "xRow")
    .map((row) => {
      const cells = childElements(row)
        .filter((cell) => cell.name === "xClmn")
        .map((cell) => `<td>${renderBlocks(cell, state)}</td>`)
        .join("\n");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");
  return `<table>${rows}</table>`;
};

const renderList = (element: Element, state: RenderState): string => {
  const bullet = childElements(element).find(
    (child) => child.name === "xBullet",
  );
  const marker = bullet === undefined ? "" : escapeHtml(textOf(bullet).trim());
  // A term per item for the bullet and the item's paragraphs as its
  // definition, as the publisher renders a list.
  const items = childElements(element)
    .filter((child) => child.name === "xEnumElem")
    .map((item) => `<dt>${marker}</dt>\n<dd>${renderBlocks(item, state)}</dd>`)
    .join("\n");
  return `<dl>${items}</dl>`;
};

const renderUnit = (element: Element, state: RenderState): string => {
  const children = childElements(element);
  const name = children.find((child) => child.name === "xName");
  const rest = children.filter((child) => child !== name);
  if (element.attribs["xIsTitle"] === "true") {
    const heading =
      name === undefined ? "" : `<h2>${escapeHtml(textOf(name).trim())}</h2>`;
    return `<div>${heading}${rest.map((child) => renderBlock(child, state)).join("\n")}</div>`;
  }
  // A numbered point: its number opens its first paragraph, as printed.
  const label = unitLabel(name);
  const [first, ...others] = rest;
  if (first?.name === "xText" && label.length > 0) {
    return `<p>${escapeHtml(label)} ${renderInlines(first, state)}</p>${others
      .map((child) => renderBlock(child, state))
      .join("\n")}`;
  }
  const opening = label.length > 0 ? `<p>${escapeHtml(label)}</p>` : "";
  return `${opening}${rest.map((child) => renderBlock(child, state)).join("\n")}`;
};

const renderBlock = (element: Element, state: RenderState): string => {
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
        return "";
      }
      state.unmapped.add(element.name);
      return `<p>${renderInlines(element, state)}</p>`;
    }
  }
};

const renderBlocks = (element: Element, state: RenderState): string =>
  childElements(element)
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
  const html = children
    .filter((child) => child !== name)
    .map((child) => renderBlock(child, state))
    .join("\n");
  const title =
    name === undefined ? undefined : textOf(name).trim() || undefined;
  return {
    attributes: { ...root.attribs },
    title,
    html,
    legalReferences: state.legalReferences,
    unmappedMarkup: [...state.unmapped],
    sourceParagraphs: sourceParagraphsOf(root),
  };
};

/** Elements whose text is a paragraph of the document as the court wrote it. */
const TEXT_ELEMENTS = new Set(["xText", "xTitle", "xName"]);

const sourceParagraphsOf = (root: Element): string[] => {
  const paragraphs: string[] = [];
  const walk = (element: Element): void => {
    for (const child of childElements(element)) {
      if (!TEXT_ELEMENTS.has(child.name)) {
        walk(child);
        continue;
      }
      // The root's own name is the document's label, not its text.
      const text =
        element === root ? "" : textOf(child).replace(/\s+/gu, " ").trim();
      if (text.length > 0) {
        paragraphs.push(text);
      }
    }
  };
  walk(root);
  return paragraphs;
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
): ValidationResult =>
  validateAndLog(
    subject,
    buildValidationHtml(content.sourceParagraphs.map(escapeHtml)),
    blocks,
  );
