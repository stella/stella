// parser-output-unchanged: imports moved to @stll/case-law-parsers; runtime behavior unchanged.
// parser-output-unchanged: sections-from-ast moved verbatim to @stll/legal-ast without behavior changes.
// parser-output-unchanged: decision section and metadata types moved to @stll/legal-ast without behavior changes.
/**
 * The Supreme Court's official collection (sbirka.nsoud.cz), read from an
 * entry's detail page.
 *
 * The page is a WordPress post. Its heading (`<h1>`) states the decision's
 * type, court, date, docket and, for most entries, ECLI; its breadcrumb names
 * the collection year and issue; and one table (`table.content-table`) holds
 * one row per labelled field (`<td>Label:</td><td>value</td>`) followed by an
 * unlabelled row whose cell opens with the heading "Sbírkový text rozhodnutí"
 * and holds the collection's edited text of the decision. A second table
 * below it (`.detail-section__hidden`) holds the rows only some entries state:
 * the annotation, the collection entries the decision bears on, and the
 * constitutional complaint lodged against it. Some labels carry a tooltip
 * (the court's name may differ from the printed collection; the annotation is
 * not the court's binding opinion); a tooltip is the page's, not the field's.
 *
 * The text is HTML paragraphs. Two paragraph shapes carry structure, and
 * both are read from the markup alone, never from wording:
 *
 * - a centred paragraph set wholly in bold (`<p style="text-align: center">
 *   <strong>Z odůvodnění:</strong></p>`) is a heading;
 * - a paragraph set wholly in italics is the editors' summary of the case's
 *   history before the court, which the collection prints above the reasons
 *   and which is not the court's own words.
 *
 * The cell's own heading opens the document as the publisher's heading.
 * Everything else is a paragraph in printed order.
 */
import { Result, TaggedError } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { load } from "@stll/html";
import type * as cheerio from "@stll/html";
import { type AnyNode, isTag, isText } from "@stll/html/nodes";
// parser-output-unchanged: imports the document AST from its package owner
import type {
  Block,
  DocumentAst,
  HeadingRole,
  Inline,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";
import type { DecisionSection } from "@stll/legal-ast/document-types";
import { normalizeInlineLine } from "@stll/legal-ast/inline-line";
import { sectionsFromAst } from "@stll/legal-ast/sections-from-ast";
import { positionalBlockAnchor } from "@stll/legal-ast/stable-block-anchors";

import {
  isExcludedHtmlTag,
  ownTableRows,
  visibleHtmlText,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import type { CzNsReportEdition } from "@/api/lib/legal-search/cz-ns-collection-entry";
import { courtParagraphNumbers } from "@/api/lib/legal-search/parsers/court-paragraph-numbers";

const SOURCE_SYSTEM = "sbirka.nsoud.cz";

/** A collection text this parser cannot turn into a document. */
export class CzNsSbirkaParseError extends TaggedError("CzNsSbirkaParseError")<{
  message: string;
}> {}

/** The heading of the row holding the collection's text of the decision. */
export const CZ_NS_SBIRKA_TEXT_HEADING = "Sbírkový text rozhodnutí";

/** The block that opens the text cell with that heading. */
const TEXT_HEADING_SELECTOR = ".detail-section__table-heading";

/** One entry's detail page, read: every labelled row and the text cell. */
export type CzNsSbirkaPage = {
  /** The `<h1>`, whitespace collapsed. */
  title: string | undefined;
  /** Breadcrumb links between the archive and the entry, in order. */
  breadcrumb: readonly string[];
  /**
   * Every labelled row, by label without its colon, as text: one line per
   * line the cell prints (`<br />` and paragraph ends), whitespace collapsed.
   */
  fields: ReadonlyMap<string, readonly string[]>;
  /** The keyword chips the page prints, one per keyword, in order. */
  keywordChips: readonly string[];
  /** The text cell's heading as printed, where the page has a text row. */
  textHeading: string | undefined;
  /** The text cell's markup, its heading included. */
  textHtml: string | undefined;
  /** The PDF and ePUB export links, as the page states them. */
  exports: { pdf: string | undefined; epub: string | undefined };
};

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** Elements that end a printed line inside a field cell. */
const LINE_ENDING_ELEMENTS = "p, div, li";

/** A field cell's text, one entry per printed line. */
const cellLines = (cell: cheerio.Cheerio<AnyNode>): string[] => {
  const copy = cell.clone();
  copy.find("br").replaceWith("\n");
  copy.find(LINE_ENDING_ELEMENTS).after("\n");
  return visibleHtmlText(copy)
    .split("\n")
    .flatMap((line) => {
      const text = collapse(line);
      return text === "" ? [] : [text];
    });
};

/** Read one entry's detail page into its labelled parts. */
export const readCzNsSbirkaPage = (html: string): CzNsSbirkaPage => {
  const $ = load(html);
  const fields = new Map<string, readonly string[]>();
  let textHeading: string | undefined;
  let textHtml: string | undefined;
  // The main table, then the table the page sets below it for the rows it
  // states for some entries only (Anotace, Dotčená rozhodnutí, Ústavní
  // stížnost).
  const rows = [
    ...ownTableRows($("table.content-table").first()).toArray(),
    ...ownTableRows($(".detail-section__hidden table").first()).toArray(),
  ];
  for (const row of rows) {
    const cells = $(row).children("td");
    const labelCell = cells.eq(0).clone();
    labelCell.find(".tooltip2").remove();
    const label = collapse(visibleHtmlText(labelCell));
    const valueCell = cells.eq(1);
    const heading = valueCell.children(TEXT_HEADING_SELECTOR);
    if (label === "" && heading.length > 0) {
      textHeading = collapse(visibleHtmlText(heading));
      textHtml = valueCell.html() ?? "";
      continue;
    }
    if (label.endsWith(":") && label.length > 1) {
      fields.set(label.slice(0, -1).trimEnd(), cellLines(valueCell));
    }
  }
  const linkOf = (pattern: string): string | undefined =>
    $(`a[href*="${pattern}"]`).first().attr("href")?.trim();
  return {
    title: collapse(visibleHtmlText($("h1").first())) || undefined,
    breadcrumb: $(".breadcrumbs a")
      .toArray()
      .map((link) => collapse(visibleHtmlText($(link)))),
    fields,
    keywordChips: $(".detail-section__top span.btn")
      .toArray()
      .flatMap((chip) => {
        const text = collapse(visibleHtmlText($(chip)));
        return text === "" ? [] : [text];
      }),
    textHeading,
    textHtml,
    exports: {
      pdf: linkOf("/export/sbirky?"),
      epub: linkOf("/export/epub-sbirky?"),
    },
  };
};

// ── Text ─────────────────────────────────────────────────

/** What the stored row says about the entry, for the document's header. */
export type CzNsSbirkaDocumentIdentity = {
  postId: string;
  sourceUrl: string;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  keywords: readonly string[];
  statutes: readonly string[];
};

export type CzNsSbirkaParsedDocument = {
  documentAst: DocumentAst;
  fulltext: string;
  reportEdition: CzNsReportEdition | undefined;
  /** Present where the text sets at least one heading. */
  sections: DecisionSection[] | undefined;
};

type BlockDraft =
  | { type: "heading"; role: HeadingRole; inlines: Inline[] }
  | { type: "paragraph"; role: ParagraphRole | undefined; inlines: Inline[] };

/** Whether every visible character of `element` sits inside `selector`. */
const wholly = (
  element: cheerio.Cheerio<AnyNode>,
  selector: string,
): boolean => {
  if (
    collapse(visibleHtmlText(element)) === "" ||
    element.find(selector).length === 0
  ) {
    return false;
  }
  const rest = element.clone();
  rest.find(selector).remove();
  return collapse(visibleHtmlText(rest)) === "";
};

const CENTRED_STYLE = /text-align:\s*center/iu;

/** A paragraph's shape, read from its markup alone. */
const paragraphDraft = (
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<AnyNode>,
): BlockDraft => {
  const inlines = walkInlines($, element, { superscripts: true });
  if (
    CENTRED_STYLE.test(element.attr("style") ?? "") &&
    wholly(element, "strong, b")
  ) {
    return { type: "heading", role: "section-heading", inlines };
  }
  return {
    type: "paragraph",
    role: wholly(element, "em, i") ? "apparatus" : undefined,
    inlines,
  };
};

/** Every block under `root`, in printed order. */
const textDrafts = (
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
): BlockDraft[] => {
  const drafts: BlockDraft[] = [];
  const visit = (node: AnyNode): void => {
    if (isText(node)) {
      drafts.push({
        type: "paragraph",
        role: undefined,
        inlines: [{ type: "text", text: node.data }],
      });
      return;
    }
    if (!isTag(node) || isExcludedHtmlTag(node.name) || node.name === "hr") {
      return;
    }
    const element = $(node);
    switch (node.name) {
      case "p":
        drafts.push(paragraphDraft($, element));
        return;
      case "table":
        // One paragraph per cell, so cells never run together into one word.
        for (const row of ownTableRows(element).toArray()) {
          for (const cell of $(row).children("td, th").toArray()) {
            drafts.push({
              type: "paragraph",
              role: undefined,
              inlines: walkInlines($, $(cell), { superscripts: true }),
            });
          }
        }
        return;
      case "div":
      case "section":
      case "blockquote":
      case "ul":
      case "ol":
        for (const child of node.children) {
          visit(child);
        }
        return;
      default:
        drafts.push({
          type: "paragraph",
          role: undefined,
          inlines: walkInlines($, element, { superscripts: true }),
        });
    }
  };
  for (const node of root.contents().toArray()) {
    visit(node);
  }
  return drafts;
};

/**
 * One space per gap; a draft with no text is no block. The editors' summary
 * opens the text, before the court's words: a wholly italic paragraph after
 * the body has started is the court's own emphasis, not apparatus.
 */
const numberedBlocks = (drafts: readonly BlockDraft[]): Block[] => {
  const blocks: Block[] = [];
  let bodyStarted = false;
  for (const candidate of drafts) {
    const line = normalizeInlineLine(candidate.inlines);
    if (collapse(line.plainText) === "") {
      continue;
    }
    const headMatter =
      candidate.type === "heading"
        ? candidate.role === "publisher-heading"
        : candidate.role === "apparatus";
    const draft: BlockDraft =
      bodyStarted && candidate.type === "paragraph" && headMatter
        ? { ...candidate, role: undefined }
        : candidate;
    bodyStarted ||= !headMatter;
    const position = blocks.length + 1;
    blocks.push(
      draft.type === "heading"
        ? {
            id: `b${position}`,
            anchorId: positionalBlockAnchor({ kind: "h", ordinal: position }),
            type: "heading",
            level: 1,
            role: draft.role,
            inlines: line.inlines,
            plainText: line.plainText,
          }
        : {
            id: `b${position}`,
            anchorId: positionalBlockAnchor({ kind: "p", ordinal: position }),
            type: "paragraph",
            ...(draft.role === undefined ? {} : { role: draft.role }),
            inlines: line.inlines,
            plainText: line.plainText,
          },
    );
  }
  return blocks;
};

const chapterTitle = (value: string) =>
  collapse(value.replaceAll(".", "")).toLocaleLowerCase("cs");

const NUMBERED_SUBSECTION = /^(?<number>[1-9]\d{0,5})\.\s+\p{L}/u;

/** Both editions print a contents block naming the chapters around the numbered sections. */
const reportEdition = (
  blocks: readonly Block[],
): CzNsReportEdition | undefined => {
  const contentsIndex = blocks.findIndex(({ plainText }) =>
    /^OBSAH\s+I\./u.test(plainText),
  );
  const contents = blocks.at(contentsIndex);
  if (contentsIndex === -1 || contents === undefined) {
    return undefined;
  }
  const titles = chapterTitle(contents.plainText);
  const chapter = (marker: string, after: number) =>
    blocks.findIndex(({ plainText }, index) => {
      if (index <= after || plainText.length > contents.plainText.length) {
        return false;
      }
      const title = chapterTitle(plainText);
      return title.startsWith(marker) && titles.includes(title);
    });
  const secondChapter = chapter("ii ", contentsIndex);
  const thirdChapter = chapter("iii ", secondChapter);
  if (secondChapter < 0 || thirdChapter <= secondChapter + 1) {
    return undefined;
  }
  const sectionHeadings = (from: number, to: number) =>
    blocks.slice(from, to).flatMap(({ plainText }, offset) => {
      const number = NUMBERED_SUBSECTION.exec(plainText)?.groups?.["number"];
      return number === undefined ? [] : [{ number, index: from + offset }];
    });
  const sections = sectionHeadings(secondChapter + 1, thirdChapter);
  const first = sections.at(0);
  if (
    first?.index !== secondChapter + 1 ||
    sections.some(
      (heading, i) =>
        (sections.at(i + 1)?.index ?? thirdChapter) <= heading.index + 1,
    )
  ) {
    return undefined;
  }
  if (sections.length === 1) {
    const label =
      blocks.at(0)?.type === "heading" ? blocks.at(1) : blocks.at(0);
    const number = /^Č\.\s*(?<number>[1-9]\d*)$/u.exec(label?.plainText ?? "")
      ?.groups?.["number"];
    if (number === undefined || label === undefined) {
      return undefined;
    }
    return {
      extent: "section",
      number,
      sectionPart: {
        sectionNumber: parseIntegerToken(first.number, {
          sign: "unsigned",
        }).unwrap(
          "A matched subsection number contains at most six decimal digits",
        ),
        firstBlock: secondChapter + 1,
        afterLastBlock: thirdChapter,
        collectionLabel: label.plainText,
      },
    };
  }
  const listed = sectionHeadings(contentsIndex + 1, secondChapter);
  return listed.length > 1 &&
    listed.length === sections.length &&
    listed.every(
      ({ number }, i) =>
        number === String(i + 1) && sections.at(i)?.number === number,
    )
    ? { extent: "complete" }
    : undefined;
};

/**
 * The collection's text of one entry as a document, or a typed failure when
 * nothing in it survived. Text retention is the pipeline's to validate,
 * against the stored page.
 */
export const parseCzNsSbirkaText = (
  textHtml: string,
  identity: CzNsSbirkaDocumentIdentity,
): Result<CzNsSbirkaParsedDocument, CzNsSbirkaParseError> => {
  const $ = load(`<body>${textHtml}</body>`);
  const body = $("body");
  // The cell opens with the page's own heading over the text, kept as the
  // publisher's heading; a cell holding nothing else holds no text.
  const heading = body.children(TEXT_HEADING_SELECTOR).first();
  const headingInlines = walkInlines($, heading);
  heading.remove();
  const drafts = textDrafts($, body);
  if (
    !drafts.some(
      (draft) => collapse(normalizeInlineLine(draft.inlines).plainText) !== "",
    )
  ) {
    return Result.err(
      new CzNsSbirkaParseError({
        message: `Collection entry ${identity.postId} holds no text`,
      }),
    );
  }
  // Recent entries number their paragraphs ("1. Žalobou …"); the number
  // moves onto the block where the paragraphs read as one numbering.
  const printedBlocks = numberedBlocks([
    { type: "heading", role: "publisher-heading", inlines: headingInlines },
    ...drafts,
  ]);
  const blocks = courtParagraphNumbers(printedBlocks, {
    parser: SOURCE_SYSTEM,
    caseNumber: identity.caseNumber,
    url: identity.sourceUrl,
  });
  return Result.ok({
    reportEdition: reportEdition(printedBlocks),
    documentAst: {
      version: 1,
      source: {
        system: SOURCE_SYSTEM,
        documentId: identity.postId,
        webUrl: identity.sourceUrl,
        printUrl: "",
      },
      metadata: {
        caseNumber: identity.caseNumber,
        ecli: identity.ecli ?? null,
        court: identity.court,
        decisionDate: identity.decisionDate ?? null,
        decisionType: identity.decisionType ?? null,
        keywords: [...identity.keywords],
        statutes: [...identity.statutes],
      },
      blocks,
    },
    fulltext: blocks.map((block) => block.plainText).join("\n\n"),
    sections: blocks.some((block) => block.type === "heading")
      ? sectionsFromAst(blocks)
      : undefined,
  });
};
