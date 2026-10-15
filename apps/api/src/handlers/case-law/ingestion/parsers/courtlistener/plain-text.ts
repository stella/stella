// parser-output-unchanged: shared exclusion and text helpers discard the same script/style content as the existing walks.
/**
 * Unmarked opinion text: the `plain_text` column, and the preformatted
 * bodies CourtListener serves as `<pre>` runs with citation links between
 * them. Both carry layout, not structure, so the only structure read is the
 * layout's own: blank lines and a first-line indent open a paragraph, and
 * every other line break stays a line break. No heading is inferred from a
 * line's wording or capitals, and no page is inferred from a `*123`.
 *
 * Layout proves no body and note runs: a page's notes print as ordinary
 * paragraphs at its foot. So a printed page break always ends a paragraph,
 * which keeps one page's notes and the next page's body apart, and every
 * paragraph is scoped alone.
 */

import * as cheerio from "cheerio";
import { type AnyNode, isTag, isText } from "domhandler";

// parser-output-unchanged: imports the document AST from its package owner
import type { Inline } from "@stll/legal-ast/document-ast";

import { buildValidationHtml } from "@/api/lib/legal-search/parsers/validate-ast";

import { isExcludedHtmlTag, visibleHtmlText } from "../shared-inlines";
import { conservesText, createUnitBuilder, graphicsIn } from "./blocks";
import type { FormatInput } from "./harvard-xml";
import { unitClass } from "./opinion-class";
import {
  blockAllowance,
  type FormatParse,
  spendDomNodes,
  TEXT_CANDIDATE_UNUSABLE,
} from "./outcome";

/**
 * Text with at least as many single blank lines between lines as lines
 * following each other directly is double-spaced: there a single blank line
 * is spacing, and only a wider gap separates paragraphs. A caption, a
 * signature or notes set single-spaced do not make a double-spaced body
 * single-spaced. Below this many single gaps the text is too short to tell.
 */
const DOUBLE_SPACED_MIN_GAPS = 10;

const FORM_FEED = /\f/gu;

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

type Line = {
  readonly text: string;
  readonly gapBefore: number;
  /** A printed page break (a form feed) falls before this line. */
  readonly pageBreakBefore: boolean;
};

/** Non-blank lines; a form feed is a page break and a line boundary. */
const linesOf = (text: string): Line[] => {
  const lines: Line[] = [];
  let gap = 0;
  let pageBreak = false;
  for (const [index, line] of text.split(FORM_FEED).entries()) {
    pageBreak ||= index > 0;
    for (const part of line.split("\n")) {
      if (part.trim() === "") {
        gap += 1;
        continue;
      }
      lines.push({
        text: part.trimEnd(),
        gapBefore: lines.length === 0 ? 0 : gap,
        pageBreakBefore: pageBreak,
      });
      gap = 0;
      pageBreak = false;
    }
  }
  return lines;
};

/**
 * Paragraphs as the layout shows them. A paragraph opens at a printed page
 * break, at a paragraph gap, or where a line is indented past a previous
 * line sitting at the paragraph's own margin: the first-line indent of the
 * next paragraph.
 */
export const paragraphsOf = (text: string): string[][] => {
  const lines = linesOf(text);
  const gaps = lines.slice(1).map(({ gapBefore }) => gapBefore);
  const single = gaps.filter((gap) => gap === 1).length;
  const direct = gaps.filter((gap) => gap === 0).length;
  const doubleSpaced = single >= DOUBLE_SPACED_MIN_GAPS && single >= direct;
  const paragraphGap = doubleSpaced ? 2 : 1;

  const paragraphs: string[][] = [];
  let current: string[] = [];
  let margin = 0;
  for (const line of lines) {
    const previous = current.at(-1);
    const opens =
      previous !== undefined &&
      (line.pageBreakBefore ||
        line.gapBefore >= paragraphGap ||
        (indentOf(line.text) > indentOf(previous) &&
          indentOf(previous) === margin));
    if (opens) {
      paragraphs.push(current);
      current = [];
    }
    if (current.length === 0) {
      margin = indentOf(line.text);
    }
    current.push(line.text);
    margin = Math.min(margin, indentOf(line.text));
  }
  if (current.length > 0) {
    paragraphs.push(current);
  }
  return paragraphs;
};

/** A paragraph's lines, broken where the source broke them, indents kept. */
const inlinesOf = (lines: readonly string[]): Inline[] =>
  lines.flatMap((line, index): Inline[] =>
    index === 0
      ? [{ type: "text", text: line.trimStart() }]
      : [{ type: "line-break" }, { type: "text", text: line }],
  );

const escapeParagraphs = (text: string): string =>
  buildValidationHtml(
    text.split(/\n[ \t\f]*\n/u).map((part) => Bun.escapeHTML(part)),
  );

const parseLayoutText = (
  { budget, prefix, rowType }: FormatInput,
  source: string,
  {
    publisherLinks,
    visibleText,
  }: { publisherLinks: number; visibleText: string },
): FormatParse => {
  const text = source.replace(/\r\n?/gu, "\n");
  const paginationCharacters = text.match(FORM_FEED)?.length ?? 0;
  if (text.trim() === "") {
    return {
      status: "unusable",
      reason: TEXT_CANDIDATE_UNUSABLE.NO_VISIBLE_TEXT,
    };
  }
  const builder = createUnitBuilder({
    rootOpinionPolicy: "single",
    prefix,
    bodyRole: (domType, position) => unitClass(rowType, domType, position).body,
    blockAllowance: blockAllowance(budget),
    boundaries: "layout",
  });
  builder.enterOpinion(null);
  for (const lines of paragraphsOf(text)) {
    builder.paragraph(inlinesOf(lines), "body");
  }
  builder.exitOpinion();
  const { notes, overLimit, pageAnchors, units } = builder.finish();
  if (overLimit) {
    return { status: "over-limit", limit: "BLOCKS" };
  }
  if (!conservesText(text, units)) {
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
        publisherLinks,
        paginationCharacters,
        backlinkCharacters: 0,
        unknownConstructs: {},
      },
      validationHtml: escapeParagraphs(visibleText),
    },
  };
};

export const parsePlainText = (input: FormatInput): FormatParse =>
  input.text.trim() === ""
    ? { status: "unusable", reason: TEXT_CANDIDATE_UNUSABLE.BLANK }
    : parseLayoutText(input, input.text, {
        publisherLinks: 0,
        visibleText: input.text,
      });

/** The elements a preformatted body is made of: text runs and citation links. */
const PREFORMATTED_PARTS = new Set(["pre", "span", "a"]);

const textOf = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  if (!isTag(node) || isExcludedHtmlTag(node.name.toLowerCase())) {
    return "";
  }
  if (node.name.toLowerCase() === "br") {
    return "\n";
  }
  return node.children.map(textOf).join("");
};

/**
 * A body of `<pre>` runs. Citation links between the runs are unwrapped to
 * their words. `null` where other top-level markup makes the body HTML,
 * decided from the top level alone before the tree is charged to the budget.
 */
export const parsePreformatted = (input: FormatInput): FormatParse | null => {
  if (input.text.trim() === "") {
    return { status: "unusable", reason: TEXT_CANDIDATE_UNUSABLE.BLANK };
  }
  const $ = cheerio.load(input.text, null, false);
  const foreign = $.root()
    .children()
    .toArray()
    .some(
      (part) =>
        isTag(part) &&
        !PREFORMATTED_PARTS.has(part.name.toLowerCase()) &&
        !isExcludedHtmlTag(part.name.toLowerCase()),
    );
  if (foreign) {
    return null;
  }
  const [root] = $.root().toArray();
  if (root === undefined) {
    return { status: "over-limit", limit: "DOM_NODES" };
  }
  const limit = spendDomNodes(input.budget, root);
  if (limit !== null) {
    return { status: "over-limit", limit };
  }
  const graphics = graphicsIn(root);
  if (Object.keys(graphics).length > 0) {
    return { status: "requires-assets", graphics };
  }
  // The retention check reads the source through cheerio's own text, not
  // through the walk above.
  const visible = cheerio.load(input.text, null, false);
  return parseLayoutText(
    input,
    $.root().contents().toArray().map(textOf).join(""),
    {
      publisherLinks: $("a[href]").length,
      visibleText: visibleHtmlText(visible.root()),
    },
  );
};
