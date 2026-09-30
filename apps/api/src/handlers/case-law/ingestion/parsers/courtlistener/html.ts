/**
 * CourtListener's HTML columns: `html_with_citations` where it holds HTML,
 * `html_lawbox`, `html_columbia`, `html_anon_2020`, `html`, and the
 * cluster's `headmatter`. Each is one publisher's conversion of the same
 * kind of document, so they share one vocabulary and one walk; a column's
 * entry point differs only in what its markup proves about note boundaries.
 *
 * `html_with_citations` is another column's HTML with citation links added:
 * its notes are marked where that column's notes are.
 */

import { panic } from "better-result";
import * as cheerio from "cheerio";
import {
  type Element,
  hasChildren,
  isTag,
  isText,
  type ParentNode,
} from "domhandler";

import {
  type BodyVocabulary,
  conservesText,
  createUnitBuilder,
  type DraftRole,
  graphicsIn,
  type PageAnchor,
  sourceTextOf,
  textOf,
  walkBody,
} from "./blocks";
import type { FormatInput } from "./harvard-xml";
import { unitClass } from "./opinion-class";
import {
  blockAllowance,
  type FormatParse,
  spendDomNodes,
  TEXT_CANDIDATE_UNUSABLE,
  type TextUnit,
} from "./outcome";

export const COURTLISTENER_HTML_FORMATS = [
  "html_with_citations",
  "html_lawbox",
  "html_columbia",
  "html_anon_2020",
  "html",
] as const;

export type CourtListenerHtmlFormat =
  (typeof COURTLISTENER_HTML_FORMATS)[number];

const nameOf = (element: Element): string =>
  (element.name.split(":").at(-1) ?? element.name).toLowerCase();

const classesOf = (element: Element): readonly string[] =>
  (element.attribs["class"] ?? "").split(/\s+/u);

const hasClass = (element: Element, name: string): boolean =>
  classesOf(element).includes(name);

const attribute = (element: Element, name: string): string | undefined => {
  const value = element.attribs[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const INLINES = new Set([
  "a",
  "abbr",
  "b",
  "big",
  "bracketnum",
  "cite",
  "code",
  "content",
  "counselor",
  "courtname",
  "cross_reference",
  "del",
  "dfn",
  "em",
  "emphasis",
  "extracted-citation",
  "font",
  "footnotemark",
  "footnotereference",
  "i",
  "ins",
  "label",
  "mark",
  "page-number",
  "q",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "tt",
  "u",
]);

const CONTAINERS = new Set([
  "article",
  "body",
  "bodytext",
  "casebody",
  "center",
  "div",
  "dl",
  "excerpt",
  "footer",
  "header",
  "main",
  "ol",
  "section",
  "ul",
]);

const HEADINGS = new Set(["author", "h", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Paragraph elements. The Harvard case-XML names appear in `headmatter` and
 * in HTML converted from that XML, and keep the roles the XML reader gives
 * them.
 */
const PARAGRAPHS: Readonly<Record<string, DraftRole>> = {
  address: "body",
  blockquote: "quote",
  dd: "body",
  disposition: "body",
  dt: "body",
  li: "body",
  p: "body",
  pre: "body",
  attorneys: "counsel",
  citation: "front-matter",
  correction: "apparatus",
  court: "front-matter",
  decisiondate: "front-matter",
  docketnumber: "front-matter",
  headnotes: "headnotes",
  history: "history",
  judges: "panel",
  otherdate: "front-matter",
  parties: "parties",
  seealso: "apparatus",
  summary: "summary",
  syllabus: "syllabus",
};

/**
 * The anonymized conversion's classed divisions. Its caption and summaries
 * are the publisher's, outside every opinion; `caseopinionby` is an
 * opinion's author line. Only divisions carry these: the generic column
 * reuses words like `parties` and `docket` on paragraphs of body text.
 */
const DIVISION_ROLES: Readonly<Record<string, DraftRole | "heading">> = {
  casename: "parties",
  caseopinionby: "heading",
  citations: "front-matter",
  counsel: "counsel",
  courtinfo: "front-matter",
  courtsummary: "summary",
  docketnumber: "front-matter",
  judges: "panel",
  panel: "panel",
  summaries: "apparatus",
};

const divisionRole = (element: Element): DraftRole | "heading" | undefined => {
  if (nameOf(element) !== "div") {
    return undefined;
  }
  for (const name of classesOf(element)) {
    if (Object.hasOwn(DIVISION_ROLES, name)) {
      return DIVISION_ROLES[name];
    }
  }
  return undefined;
};

/**
 * A printed page marker. Its page is stated by a `label` attribute or as
 * printed (`*253`); the anonymized conversion's `number` attribute counts
 * markers, not pages, and is not read.
 */
const pageAnchor = (element: Element): PageAnchor | undefined => {
  const name = nameOf(element);
  const marker =
    name === "page-number" ||
    (name === "span" && hasClass(element, "star-pagination")) ||
    (name === "a" && hasClass(element, "page-label"));
  if (!marker) {
    return undefined;
  }
  return {
    type: "page-anchor",
    label:
      attribute(element, "label") ??
      attribute(element, "data-label") ??
      textOf(element).replace(/\s+/gu, "").replace(/^\*/u, ""),
  };
};

/** Whether `element` is a note, in any of the columns' markups. */
const isNote = (element: Element): boolean => {
  const name = nameOf(element);
  if (name === "footnote" || name === "footnote_body") {
    return true;
  }
  if (name !== "div") {
    return false;
  }
  if (hasClass(element, "footnote")) {
    return true;
  }
  // The anonymized conversion: `div.footnotes > ul > li > div#fn_…`.
  const id = element.attribs["id"] ?? "";
  let parent = element.parent;
  while (id.startsWith("fn_") && parent !== null && isTag(parent)) {
    if (nameOf(parent) === "div" && hasClass(parent, "footnotes")) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
};

/** Only reciprocal links with a printed mark are removable note furniture. */
const prepareNotes = ($: cheerio.CheerioAPI, notes: readonly Element[]) => {
  const labels = new WeakMap<Element, string>();
  const callouts = new Map<string, { label: string; returnIds: Set<string> }>();
  const insideNote = (element: Element): boolean => {
    let parent = element.parent;
    while (parent !== null && isTag(parent)) {
      if (isNote(parent)) {
        return true;
      }
      parent = parent.parent;
    }
    return false;
  };
  $("a[href], footnotereference[anchoridref]").each((_, element) => {
    const href = element.attribs["href"] ?? "";
    const target =
      element.attribs["anchoridref"] ??
      (href.startsWith("#") ? href.slice(1) : "");
    const label = textOf(element).replace(/\s+/gu, " ").trim();
    if (target === "" || label === "" || insideNote(element)) {
      return;
    }
    const returnIds = new Set<string>();
    const ownId = attribute(element, "id");
    if (ownId !== undefined) {
      returnIds.add(ownId);
    }
    const parent = element.parent;
    if (parent !== null && isTag(parent) && nameOf(parent) === "sup") {
      const parentId = attribute(parent, "id");
      if (parentId !== undefined) {
        returnIds.add(parentId);
      }
    }
    const existing = callouts.get(target);
    if (existing === undefined) {
      callouts.set(target, { label, returnIds });
    } else if (existing.label === label) {
      for (const id of returnIds) {
        existing.returnIds.add(id);
      }
    }
  });
  let removed = 0;
  for (const note of notes) {
    const ids = [
      attribute(note, "id"),
      ...$(note)
        .find("sup[id]")
        .toArray()
        .map((element) => attribute(element, "id")),
    ];
    const callout = ids
      .flatMap((id) => (id === undefined ? [] : [callouts.get(id)]))
      .find((entry) => entry !== undefined);
    const label = attribute(note, "label") ?? callout?.label ?? "";
    labels.set(note, label);
    if (callout === undefined) {
      continue;
    }
    for (const anchor of $(note).find("a[href]").toArray()) {
      const href = anchor.attribs["href"] ?? "";
      const printed = textOf(anchor).trim();
      // The return-arrow glyph is navigation too, but still needs reciprocity.
      if (
        !href.startsWith("#") ||
        !callout.returnIds.has(href.slice(1)) ||
        (printed !== label && printed !== "↩")
      ) {
        continue;
      }
      removed += printed.length;
      $(anchor).remove();
    }
  }
  return { labels, removed };
};

/**
 * HTML repair may close Columbia's custom element at an intervening </p>.
 * Each literal note span must have the same explicit end in the parsed tree;
 * otherwise every scope in this candidate is unproven. Never infer safety
 * from the column name or from another well-formed note in the same row.
 */
const noteSpanDefects = (text: string, notes: readonly Element[]): number => {
  const spans = new Map<number, number>();
  const opened: number[] = [];
  let defects = 0;
  for (const token of text.matchAll(/<\/?footnote_body\b[^>]*>/giu)) {
    if (token[0].startsWith("</")) {
      const start = opened.pop();
      if (start === undefined) {
        defects += 1;
      } else {
        spans.set(start, token.index);
      }
    } else {
      opened.push(token.index);
    }
  }
  for (const start of opened) {
    spans.set(start, -1);
  }
  for (const note of notes) {
    if (nameOf(note) !== "footnote_body") {
      continue;
    }
    const location = note.sourceCodeLocation;
    const start = location?.startOffset;
    const end = start === undefined ? undefined : spans.get(start);
    if (end === undefined || location?.endTag?.startOffset !== end) {
      defects += 1;
    }
    if (start !== undefined) {
      spans.delete(start);
    }
  }
  return defects + spans.size;
};

/** Leading layout headings describe the case, not the court's reasoning. */
const captionElements = (root: ParentNode): WeakSet<Element> => {
  const captions = new WeakSet<Element>();
  const classes = new Set(["case_cite", "parties", "docket", "court", "date"]);
  const mark = (element: Element) => {
    captions.add(element);
    for (const child of element.children) {
      if (isTag(child)) {
        mark(child);
      }
    }
  };
  const visit = (container: ParentNode): boolean => {
    for (const child of container.children) {
      if (isText(child)) {
        if (child.data.trim() !== "") {
          return true;
        }
        continue;
      }
      if (!isTag(child)) {
        continue;
      }
      const name = nameOf(child);
      if (["script", "style", "template", "title"].includes(name)) {
        continue;
      }
      const caption =
        name === "center" ||
        name === "h1" ||
        (name === "p" && classesOf(child).some((value) => classes.has(value)));
      if (caption && !/^ORDER\.?$/u.test(textOf(child).trim())) {
        mark(child);
        continue;
      }
      if (
        name === "p" ||
        name === "pre" ||
        name === "table" ||
        HEADINGS.has(name)
      ) {
        return true;
      }
      if (visit(child)) {
        return true;
      }
    }
    return false;
  };
  visit(root);
  return captions;
};

const vocabularyFor = (
  labels: WeakMap<Element, string>,
  captions: WeakSet<Element>,
): BodyVocabulary => ({
  paragraphs: PARAGRAPHS,
  semantics: (element) =>
    captions.has(element) ? "front-matter" : divisionRole(element),
  headings: HEADINGS,
  containers: CONTAINERS,
  inlines: INLINES,
  opinion: (element) => {
    const name = nameOf(element);
    if (name === "opinion") {
      return { domType: attribute(element, "type") ?? null };
    }
    return name === "div" && hasClass(element, "opinion")
      ? { domType: attribute(element, "opiniontype") ?? null }
      : null;
  },
  footnote: (element) => {
    const label = labels.get(element);
    return label === undefined ? null : { label };
  },
  // Removed from the tree before the walk.
  backlink: () => false,
  pageAnchor,
});

/**
 * Whether the markup marks every note as one. Lawbox prints its notes as
 * ordinary paragraphs under a `NOTES` heading and the generic column mixes
 * marked notes with notes set inline, so neither proves a note boundary.
 * The citation column holds another column's markup and is read by what it
 * carries: the anonymized conversion's divisions, or Columbia's note bodies
 * and cross references.
 */
const noteBoundaries = (
  format: CourtListenerHtmlFormat,
  $: cheerio.CheerioAPI,
): TextUnit["boundaries"] => {
  switch (format) {
    case "html_anon_2020":
    case "html_columbia":
      return "markup";
    case "html_lawbox":
    case "html":
      return "layout";
    case "html_with_citations":
      return $(
        "div.courtcasedochead, div.courtcasedocbody, footnote_body, cross_reference",
      ).length > 0
        ? "markup"
        : "layout";
    default: {
      format satisfies never;
      return panic("Unhandled CourtListener HTML format");
    }
  }
};

/** Publisher links that name another document, not a place in this one. */
const publisherLinks = ($: cheerio.CheerioAPI): number =>
  $("a[href]")
    .toArray()
    .filter((element) => !element.attribs["href"]?.startsWith("#")).length;

const parseHtml =
  (
    format: CourtListenerHtmlFormat,
    context: "opinion" | "headmatter" = "opinion",
  ) =>
  ({ budget, prefix, rowType, text }: FormatInput): FormatParse => {
    if (text.trim() === "") {
      return { status: "unusable", reason: TEXT_CANDIDATE_UNUSABLE.BLANK };
    }
    // HTML parsing does not recurse, so the tree is measured before any walk
    // can recurse through it.
    const $ = cheerio.load(text, { sourceCodeLocationInfo: true });
    const [document] = $.root().toArray();
    const limit =
      document === undefined ? "DOM_NODES" : spendDomNodes(budget, document);
    if (limit !== null) {
      return { status: "over-limit", limit };
    }
    const [body] = $("body").toArray();
    if (body === undefined || !hasChildren(body)) {
      return {
        status: "unusable",
        reason: TEXT_CANDIDATE_UNUSABLE.NO_VISIBLE_TEXT,
      };
    }
    const graphics = graphicsIn(body);
    if (Object.keys(graphics).length > 0) {
      return { status: "requires-assets", graphics };
    }
    $(body)
      .find("emphasis[typestyle]")
      .each((_, element) => {
        const style = element.attribs["typestyle"];
        if (style === "it" || style === "bf") {
          element.name = style === "it" ? "em" : "strong";
        }
      });
    const notes = $(body).find("*").toArray().filter(isNote);
    const spanDefects = noteSpanDefects(text, notes);
    const preparedNotes = prepareNotes($, notes);
    const baseVocabulary = vocabularyFor(
      preparedNotes.labels,
      captionElements(body),
    );
    const vocabulary =
      context === "headmatter"
        ? { ...baseVocabulary, opinion: () => null }
        : baseVocabulary;
    const backlinkCharacters = preparedNotes.removed;
    const links = publisherLinks($);

    const builder = createUnitBuilder({
      rootOpinionPolicy: "single",
      prefix,
      bodyRole: (domType, position) =>
        context === "headmatter"
          ? "front-matter"
          : unitClass(rowType, domType, position).body,
      blockAllowance: blockAllowance(budget),
      boundaries: spanDefects === 0 ? noteBoundaries(format, $) : "layout",
    });
    const implicitOpinion =
      context === "opinion" &&
      !$(body)
        .find("*")
        .toArray()
        .some((element) => vocabulary.opinion(element) !== null);
    if (implicitOpinion) {
      builder.enterOpinion(null);
    }
    const { unknownConstructs } = walkBody({
      $,
      root: body,
      vocabulary,
      builder,
    });
    if (implicitOpinion) {
      builder.exitOpinion();
    }
    const {
      notes: noteCount,
      overLimit,
      pageAnchors,
      units,
    } = builder.finish();
    if (overLimit) {
      return { status: "over-limit", limit: "BLOCKS" };
    }
    if (units.length === 0) {
      return {
        status: "unusable",
        reason: TEXT_CANDIDATE_UNUSABLE.NO_VISIBLE_TEXT,
      };
    }
    const source = sourceTextOf(body, vocabulary);
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
          pageAnchors,
          notes: noteCount,
          publisherLinks: links,
          paginationCharacters: source.paginationCharacters,
          backlinkCharacters,
          unknownConstructs,
          noteSpanDefects: spanDefects,
        },
      },
    };
  };

/** One entry point per column, named as the column is. */
export const COURTLISTENER_HTML_PARSERS = {
  html_with_citations: parseHtml("html_with_citations"),
  html_lawbox: parseHtml("html_lawbox"),
  html_columbia: parseHtml("html_columbia"),
  html_anon_2020: parseHtml("html_anon_2020"),
  html: parseHtml("html"),
} as const satisfies Record<
  CourtListenerHtmlFormat,
  (input: FormatInput) => FormatParse
>;

/**
 * The cluster's `headmatter`: Harvard front-matter elements set in HTML
 * (`<br>` between them), so it is read as HTML with the same vocabulary.
 * It holds no opinion element; every block is outside the opinions.
 */
export const parseHeadmatter = parseHtml("html", "headmatter");
