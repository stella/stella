/**
 * Harvard case XML as CourtListener serves it in `xml_harvard`, and inside
 * `html_with_citations` where that column holds the same XML: one
 * `<opinion>` root, author and judges lines, paragraphs, block quotations,
 * footnotes and printed page markers.
 *
 * Cheerio's XML mode repairs what it cannot read, so well-formedness is
 * checked first with slimdom. No DTD or entity declaration is accepted:
 * nothing is expanded and nothing external is resolved.
 */

import { Result } from "better-result";
import * as cheerio from "cheerio";
import { type Element, isTag } from "domhandler";
import * as slimdom from "slimdom";

import type { OpinionType } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";

import {
  type BodyVocabulary,
  cdataAsText,
  conservesText,
  createUnitBuilder,
  graphicsIn,
  type PageAnchor,
  sourceTextOf,
  textOf,
  walkBody,
} from "./blocks";
import { unitClass } from "./opinion-class";
import {
  blockAllowance,
  type FormatParse,
  spendDomNodes,
  TEXT_CANDIDATE_UNUSABLE,
  type TextBudget,
} from "./outcome";

export type FormatInput = {
  readonly text: string;
  /** Prefix of every block and note ID, unique to the opinion row. */
  readonly prefix: string;
  readonly rowType: OpinionType;
  readonly budget: TextBudget;
};

const XML_DECLARATION = /^\uFEFF?\s*<\?xml\s[^?]*\?>/u;
const DOCUMENT_TYPE = /<!(?:DOCTYPE|ENTITY)/iu;

/** The text after a leading XML declaration, the only one a fragment may carry. */
export const withoutXmlDeclaration = (text: string): string =>
  text.replace(XML_DECLARATION, "");

const classesOf = (element: Element): readonly string[] =>
  (element.attribs["class"] ?? "").split(/\s+/u);

const hasClass = (element: Element, name: string): boolean =>
  classesOf(element).includes(name);

const attribute = (element: Element, name: string): string | undefined => {
  const value = element.attribs[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/** The attribute a page marker states its page in, or `null` for no marker. */
const pageLabelAttribute = (element: Element): string | null => {
  const name = element.name.toLowerCase();
  if (name === "page-number") {
    return "label";
  }
  if (name === "span" && hasClass(element, "star-pagination")) {
    return "label";
  }
  return name === "a" && hasClass(element, "page-label") ? "data-label" : null;
};

const pageAnchor = (element: Element): PageAnchor | undefined => {
  const labelAttribute = pageLabelAttribute(element);
  if (labelAttribute === null) {
    return undefined;
  }
  return {
    type: "page-anchor",
    label:
      attribute(element, labelAttribute) ??
      textOf(element).replace(/\s+/gu, ""),
  };
};

const isNoteBacklink = (element: Element): boolean =>
  element.name.toLowerCase() === "a" && hasClass(element, "footnote");

const HARVARD_VOCABULARY: BodyVocabulary = {
  paragraphs: {
    p: "body",
    disposition: "body",
    blockquote: "quote",
    judges: "panel",
    headnotes: "headnotes",
    syllabus: "syllabus",
    summary: "summary",
    attorneys: "counsel",
    parties: "parties",
    docketnumber: "front-matter",
    court: "front-matter",
    decisiondate: "front-matter",
    otherdate: "front-matter",
    citation: "front-matter",
    history: "history",
    seealso: "apparatus",
    correction: "apparatus",
  },
  headings: new Set(["author"]),
  containers: new Set(["casebody", "div"]),
  inlines: new Set([
    "a",
    "b",
    "bracketnum",
    "cite",
    "em",
    "extracted-citation",
    "footnotemark",
    "i",
    "page-number",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "u",
  ]),
  opinion: (element) =>
    element.name.toLowerCase() === "opinion"
      ? { domType: attribute(element, "type") ?? null }
      : null,
  footnote: (element) => {
    const name = element.name.toLowerCase();
    if (name === "footnote") {
      return { label: attribute(element, "label") ?? "" };
    }
    if (name !== "div" || !hasClass(element, "footnote")) {
      return null;
    }
    const backlink = element.children.find(
      (child): child is Element => isTag(child) && isNoteBacklink(child),
    );
    return {
      label:
        attribute(element, "label") ??
        (backlink === undefined
          ? ""
          : textOf(backlink).replace(/\s+/gu, " ").trim()),
    };
  },
  backlink: isNoteBacklink,
  pageAnchor,
};

/**
 * Whether `body` is a well-formed XML fragment of elements, read inside a
 * synthetic wrapper so a fragment without one root is still checked.
 */
const isWellFormedFragment = (body: string): boolean => {
  const parsed = Result.try(() =>
    slimdom.parseXmlDocument(`<cl-fragment>${body}</cl-fragment>`),
  );
  if (Result.isError(parsed)) {
    return false;
  }
  const root = parsed.value.documentElement;
  if (root === null) {
    return false;
  }
  return Array.from(root.childNodes).every(
    (node) =>
      node.nodeType !== slimdom.Node.TEXT_NODE ||
      (node.nodeValue ?? "").trim() === "",
  );
};

export const parseHarvardXml = ({
  budget,
  prefix,
  rowType,
  text,
}: FormatInput): FormatParse => {
  const body = withoutXmlDeclaration(text);
  if (body.trim() === "") {
    return { status: "unusable", reason: TEXT_CANDIDATE_UNUSABLE.BLANK };
  }
  if (DOCUMENT_TYPE.test(body)) {
    return { status: "unusable", reason: TEXT_CANDIDATE_UNUSABLE.DECLARED_DTD };
  }
  // Cheerio's parser does not recurse, so the tree is measured before the
  // well-formedness check or any walk can recurse through it.
  const $ = cheerio.load(body, { xml: true });
  const [root] = $.root().toArray();
  if (root === undefined) {
    return { status: "over-limit", limit: "DOM_NODES" };
  }
  const limit = spendDomNodes(budget, root);
  if (limit !== null) {
    return { status: "over-limit", limit };
  }
  if (!isWellFormedFragment(body)) {
    return {
      status: "unusable",
      reason: TEXT_CANDIDATE_UNUSABLE.MALFORMED_XML,
    };
  }
  if ($("opinion").length === 0) {
    return {
      status: "unusable",
      reason: TEXT_CANDIDATE_UNUSABLE.MISSING_OPINION,
    };
  }
  const graphics = graphicsIn(root);
  if (Object.keys(graphics).length > 0) {
    return { status: "requires-assets", graphics };
  }
  cdataAsText(root);

  const builder = createUnitBuilder({
    rootOpinionPolicy: "multiple",
    prefix,
    bodyRole: (domType, position) => unitClass(rowType, domType, position).body,
    blockAllowance: blockAllowance(budget),
    boundaries: "markup",
  });
  const { unknownConstructs } = walkBody({
    $,
    root,
    vocabulary: HARVARD_VOCABULARY,
    builder,
  });
  const { notes, overLimit, pageAnchors, units } = builder.finish();
  if (overLimit) {
    return { status: "over-limit", limit: "BLOCKS" };
  }
  if (units.length === 0) {
    return {
      status: "unusable",
      reason: TEXT_CANDIDATE_UNUSABLE.NO_VISIBLE_TEXT,
    };
  }
  // The source text is read by its own walk over the XML tree, with XML's
  // semantics: CDATA is text, and nothing is reparsed as HTML.
  const source = sourceTextOf(root, HARVARD_VOCABULARY);
  if (!conservesText(source.paragraphs.join(" "), units)) {
    return {
      status: "unusable",
      reason: TEXT_CANDIDATE_UNUSABLE.TEXT_NOT_CONSERVED,
    };
  }
  return {
    status: "parsed",
    text: {
      units,
      counts: {
        noteSpanDefects: 0,
        pageAnchors,
        notes,
        publisherLinks:
          $("a[href]").not(".footnote, .page-label").length +
          $("extracted-citation").length,
        paginationCharacters: source.paginationCharacters,
        backlinkCharacters: source.backlinkCharacters,
        unknownConstructs,
      },
    },
  };
};
