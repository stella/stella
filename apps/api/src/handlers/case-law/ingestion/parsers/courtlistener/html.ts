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
import { type Element, hasChildren, isTag } from "domhandler";

import { buildValidationHtml } from "@/api/lib/legal-search/parsers/validate-ast";

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

const IN_PAGE = /^#/u;

/** An element whose only job, inside a note, is to link back to its callout. */
const isBacklink = (element: Element): boolean => {
  const name = nameOf(element);
  const href = element.attribs["href"] ?? "";
  if (name === "a") {
    return (
      hasClass(element, "footnote") ||
      href.startsWith("#ref-") ||
      href.startsWith("#fnr_")
    );
  }
  // Columbia prints the note's mark as `<sup id="fn1"><a href="#ref-fn1">`.
  return (
    name === "sup" &&
    element.children.some((child) => isTag(child) && isBacklink(child))
  );
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

/**
 * Each note's printed mark, read before its backlink is removed: a `label`
 * attribute, the callout that links to the note, or the note's own backlink.
 */
const noteLabels = (
  $: cheerio.CheerioAPI,
  notes: readonly Element[],
): WeakMap<Element, string> => {
  const callouts = new Map<string, string>();
  $("a[href], footnotereference[anchoridref]").each((_, element) => {
    const target =
      element.attribs["anchoridref"] ??
      (element.attribs["href"] ?? "").replace(IN_PAGE, "");
    const printed = textOf(element).replace(/\s+/gu, " ").trim();
    if (!callouts.has(target) && printed !== "") {
      callouts.set(target, printed);
    }
  });
  const labels = new WeakMap<Element, string>();
  for (const note of notes) {
    const backlink = $(note).find("*").toArray().find(isBacklink);
    labels.set(
      note,
      attribute(note, "label") ??
        callouts.get(note.attribs["id"] ?? "") ??
        (backlink === undefined
          ? ""
          : textOf(backlink).replace(/\s+/gu, " ").trim()),
    );
  }
  return labels;
};

/**
 * Removes every backlink inside a note, a declared removal: its mark moves
 * to the note's label. Returns the characters taken off the text axis.
 */
const removeBacklinks = (
  $: cheerio.CheerioAPI,
  notes: readonly Element[],
): number => {
  let removed = 0;
  for (const note of notes) {
    for (const backlink of $(note).find("*").toArray().filter(isBacklink)) {
      removed += textOf(backlink).trim().length;
      $(backlink).remove();
    }
  }
  return removed;
};

const vocabularyFor = (labels: WeakMap<Element, string>): BodyVocabulary => ({
  paragraphs: PARAGRAPHS,
  semantics: divisionRole,
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
    const $ = cheerio.load(text);
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
    const baseVocabulary = vocabularyFor(noteLabels($, notes));
    const vocabulary =
      context === "headmatter"
        ? { ...baseVocabulary, opinion: () => null }
        : baseVocabulary;
    const backlinkCharacters = removeBacklinks($, notes);
    const links = publisherLinks($);

    const builder = createUnitBuilder({
      prefix,
      bodyRole: (domType, position) =>
        context === "headmatter"
          ? "front-matter"
          : unitClass(rowType, domType, position).body,
      blockAllowance: blockAllowance(budget),
      boundaries: noteBoundaries(format, $),
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
        },
        validationHtml: buildValidationHtml(
          source.paragraphs.map((paragraph) => Bun.escapeHTML(paragraph)),
        ),
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
