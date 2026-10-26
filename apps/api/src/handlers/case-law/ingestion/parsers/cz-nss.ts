// parser-output-unchanged: AST validation reuses the unmodified parsed document; diagnostics and stored parser output remain unchanged.
/**
 * Czech Supreme Administrative Court (NSS) HTML parser.
 *
 * Converts Aspose.Words HTML from vyhledavac.nssoud.cz
 * /DokumentOriginal/Html/{id} into a canonical DocumentAst.
 *
 * The HTML uses <p> elements with inline styles for alignment
 * and <span> elements with font-weight/font-style for emphasis.
 * Paragraph numbers appear as [N] at the start of paragraphs.
 *
 * Structure:
 *   case number + "pokračování"
 *   [OBRÁZEK] / ČESKÁ REPUBLIKA
 *   ROZSUDEK / USNESENÍ + JMÉNEM REPUBLIKY
 *   intro paragraph ("Nejvyšší správní soud rozhodl...")
 *   takto:
 *   I. / II. / III. ... (ruling items)
 *   Odůvodnění:
 *   I. Section heading / II. Section heading ...
 *   [1] ... [2] ... (numbered paragraphs)
 *   Poučení:
 *   V Brně dne ...
 *   Judge name + title
 */

import * as cheerio from "cheerio";
import { isComment, isText } from "domhandler";
import type { AnyNode } from "domhandler";

import { opensWithCourtParagraphMarker } from "@stll/legal-ast/court-paragraph-numbers";
import {
  CZ_CLOSING_RE as CLOSING_RE,
  CZ_JUDGE_TITLE_RE as SIGNATURE_RE,
} from "@stll/legal-ast/czech-document-roles";
// parser-output-unchanged: imports the document AST from its package owner
// parser-output-unchanged: The output is typed as a decision document AST; the emitted AST is unchanged.
import type {
  Block,
  DecisionDocumentAst,
  Inline,
  ParagraphBlock,
} from "@stll/legal-ast/document-ast";
import { normalizeInlineLine } from "@stll/legal-ast/inline-line";
import { normalizeUnicode } from "@stll/text-normalize";

import { courtParagraphNumbers } from "@/api/lib/legal-search/parsers/court-paragraph-numbers";
import { collapseLetterSpacing } from "@/api/lib/legal-search/parsers/letter-spacing";
import {
  continuesAcrossPageBreak,
  CZ_RUNNING_HEADER_SOURCE,
  withoutSoftHyphens,
} from "@/api/lib/legal-search/parsers/page-furniture";
import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";

import {
  inlinesToPlainText,
  isExcludedHtmlTag,
  ownTableRows,
  stripFurniturePrefix,
  visibleHtmlText,
  walkInlines as walkInlinesShared,
} from "./shared-inlines";

// ── Public API ─────────────────────────────────────────────

export type ParseNssDecisionInput = {
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
  /** Rich HTML from /DokumentOriginal/Html/{id}. */
  html: string;
  /** Structured metadata from the detail page. */
  detailMetadata: Record<string, unknown>;
};

type ParseNssDecisionOutput = {
  documentAst: DecisionDocumentAst;
  fulltext: string;
};

export const parseNssDecisionHtml = (
  input: ParseNssDecisionInput,
): ParseNssDecisionOutput => {
  const $ = cheerio.load(input.html);
  const chunks = extractChunks($);
  const blocks = courtParagraphNumbers(classifyChunks(chunks), {
    parser: "cz-nss",
    caseNumber: input.caseNumber,
    url: input.sourceUrl,
  });

  validateAndLog(
    { parser: "cz-nss", caseNumber: input.caseNumber, url: input.sourceUrl },
    input.html,
    blocks,
    { document: $ },
  );

  const fulltext = blocks
    .flatMap((b) => (b.plainText ? [b.plainText] : []))
    .join("\n\n");

  const ast: DecisionDocumentAst = {
    version: 1,
    source: {
      system: "nssoud.cz",
      documentId: input.caseNumber,
      webUrl: input.sourceUrl ?? "",
      printUrl: "",
    },
    metadata: {
      caseNumber: input.caseNumber,
      ecli: input.ecli ?? null,
      court: input.court,
      decisionDate: input.decisionDate ?? null,
      decisionType: input.decisionType ?? null,
      keywords: [],
      statutes: [],
    },
    blocks,
  };

  return { documentAst: ast, fulltext };
};

// ── Inline walking ─────────────────────────────────────────

/**
 * Walk a cheerio element tree and produce Inline nodes.
 * Handles the Aspose.Words span-based markup where bold/italic
 * are expressed via inline styles rather than semantic tags.
 */
const walkInlines = (
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
): Inline[] =>
  walkInlinesShared($, el, { parseImgAlt: true, parseSpanStyle: true });

// ── Chunk extraction ───────────────────────────────────────

type PChunk = {
  inlines: Inline[];
  plainText: string;
  centered: boolean;
  bold: boolean;
  letterSpacing: boolean;
  fontSize: number;
  /** Set when the chunk comes from an <ol><li>. */
  listItemIndex: number | null;
  /**
   * The list numbers its items with Arabic numerals (`<ol type="1">`, the
   * default), which the court's document prints as "1.".
   */
  decimalList: boolean;
  footnote: { anchorId: string; label: string } | null;
};

const FOOTNOTE_CONTAINER_SELECTOR = "div[id^='_ftn']";
const FOOTNOTE_ID_RE = /^_ftn(?<label>\d+)$/u;

const footnoteOf = (el: cheerio.Cheerio<AnyNode>): PChunk["footnote"] => {
  const container = el.closest(FOOTNOTE_CONTAINER_SELECTOR).first();
  const id = container.attr("id");
  const label =
    id === undefined ? undefined : FOOTNOTE_ID_RE.exec(id)?.groups?.["label"];

  return id === undefined || label === undefined
    ? null
    : { anchorId: id, label };
};

const SPACED_EMPHASIS_RE = /^(?:\p{L} +)+\p{L}(?: *[,:;.!?])?$/u;
const SINGLE_LETTER_RE = /^\p{L}$/u;
const MULTI_SPACE_MARKER = "\u0000";

type SpacedBoldRun = {
  children: Inline[];
  endIndex: number;
};

/**
 * Applied to whitespace-only text, this matches every character HTML
 * collapses: U+00A0 is the one it renders at its written width.
 */
const COLLAPSIBLE_WHITESPACE_RE = /[^\u00a0]/gu;

/**
 * Carry the part of a stepped-over whitespace node that belongs to the
 * gap between two letters. Only the non-breaking spaces count: HTML
 * collapses ordinary whitespace, so the newline and indentation a
 * pretty-printed export puts between two wrappers paint nothing and must
 * not widen a letter separator into a word boundary. Whatever survives is
 * appended as a fresh node, because the caller merges text nodes by
 * mutating them in place.
 */
const appendNonCollapsibleGap = (step: Inline[], text: string): void => {
  const gap = text.replace(COLLAPSIBLE_WHITESPACE_RE, "");
  if (gap.length > 0) {
    step.push({ type: "text", text: gap });
  }
};

const collectSpacedBoldRun = (
  source: readonly Inline[],
  startIndex: number,
): SpacedBoldRun | null => {
  const first = source.at(startIndex);
  if (first?.type !== "bold") {
    return null;
  }

  const firstText = inlinesToPlainText(first.children).replace(/\s/gu, " ");
  if (!SINGLE_LETTER_RE.test(firstText.trim())) {
    return null;
  }

  const children = [...first.children];
  let endIndex = startIndex;

  while (endIndex + 1 < source.length) {
    const step: Inline[] = [];
    let separatorIndex = endIndex + 1;
    const gapBeforeSeparator = source.at(separatorIndex);
    if (
      gapBeforeSeparator?.type === "text" &&
      gapBeforeSeparator.text.trim().length === 0
    ) {
      appendNonCollapsibleGap(step, gapBeforeSeparator.text);
      separatorIndex += 1;
    }

    const separator = source.at(separatorIndex);
    if (
      separator?.type !== "bold" ||
      inlinesToPlainText(separator.children).trim().length !== 0
    ) {
      break;
    }
    step.push(...separator.children);

    let letterIndex = separatorIndex + 1;
    const gapBeforeLetter = source.at(letterIndex);
    if (
      gapBeforeLetter?.type === "text" &&
      gapBeforeLetter.text.trim().length === 0
    ) {
      appendNonCollapsibleGap(step, gapBeforeLetter.text);
      letterIndex += 1;
    }

    const letter = source.at(letterIndex);
    if (letter?.type !== "bold") {
      break;
    }
    const letterText = inlinesToPlainText(letter.children).replace(/\s/gu, " ");
    if (!SINGLE_LETTER_RE.test(letterText.trim())) {
      break;
    }

    children.push(...step, ...letter.children);
    endIndex = letterIndex;
  }

  if (endIndex === startIndex) {
    return null;
  }

  const text = inlinesToPlainText(children).replace(/\s/gu, " ").trim();
  return SPACED_EMPHASIS_RE.test(text) ? { children, endIndex } : null;
};

/**
 * Aspose expresses letter-spacing as one emphasized node per letter. Merge
 * identical wrappers first, ignoring indentation between single-letter
 * wrappers only when their complete run proves the pattern. Then recover word
 * boundaries: one source space joins letters, while two or more source spaces
 * separate words.
 */
const normalizeNssInlines = (
  source: Inline[],
  spacedEmphasis = false,
): Inline[] => {
  const merged: Inline[] = [];

  for (let index = 0; index < source.length; index++) {
    const node = source[index];
    if (node === undefined) {
      continue;
    }

    const previous = merged.at(-1);
    const spacedBoldRun = collectSpacedBoldRun(source, index);
    if (spacedBoldRun !== null) {
      // The run goes on the bold it follows, like any adjacent bold: a word
      // whose first letter has a wrapper of its own ("P ", then "o u č e n
      // í :") is still one spaced word.
      if (previous?.type === "bold") {
        previous.children.push(...spacedBoldRun.children);
      } else {
        merged.push({ type: "bold", children: spacedBoldRun.children });
      }
      index = spacedBoldRun.endIndex;
      continue;
    }

    if (node.type === "text" && previous?.type === "text") {
      previous.text += node.text;
      continue;
    }
    if (node.type === "bold" && previous?.type === "bold") {
      previous.children.push(...node.children);
      continue;
    }
    if (node.type === "italic" && previous?.type === "italic") {
      previous.children.push(...node.children);
      continue;
    }
    if (
      node.type === "link" &&
      previous?.type === "link" &&
      previous.href === node.href
    ) {
      previous.children.push(...node.children);
      continue;
    }
    merged.push(node);
  }

  const normalized = merged.map((node): Inline => {
    if (node.type === "line-break") {
      return node;
    }
    if (node.type === "text") {
      const whitespaceNormalized = withoutSoftHyphens(node.text).replace(
        /\s/gu,
        " ",
      );
      const trimmed = whitespaceNormalized.trim();
      // The gap around a spaced word is the word boundary: "n e j s o u"
      // and the spaces after it read as "nejsou ", not "nejsou".
      const text =
        spacedEmphasis && SPACED_EMPHASIS_RE.test(trimmed)
          ? `${whitespaceNormalized.startsWith(" ") ? " " : ""}${trimmed
              .replace(/ {2,}/gu, () => MULTI_SPACE_MARKER)
              .replace(/(?<=\p{L}) (?=\p{L})/gu, "")
              .replaceAll(MULTI_SPACE_MARKER, " ")
              .replace(
                /(?<=\p{L}) +(?=[,:;.!?])/gu,
                "",
              )}${whitespaceNormalized.endsWith(" ") ? " " : ""}`
          : collapseLetterSpacing(whitespaceNormalized).replace(/ {2,}/gu, " ");
      return node.anonymized === true
        ? { type: "text", text, anonymized: true }
        : { type: "text", text };
    }
    if (node.type === "bold") {
      return {
        type: "bold",
        children: normalizeNssInlines(node.children, true),
      };
    }
    if (node.type === "italic") {
      return {
        type: "italic",
        children: normalizeNssInlines(node.children, spacedEmphasis),
      };
    }
    if (node.type === "link") {
      return {
        type: "link",
        href: node.href,
        children: normalizeNssInlines(node.children, spacedEmphasis),
      };
    }
    return node;
  });

  // A spaced word keeps the gap after it, so a text that follows with a gap
  // of its own would double it.
  for (const [index, node] of normalized.entries()) {
    const before = normalized[index - 1];
    if (
      node.type === "text" &&
      before !== undefined &&
      inlinesToPlainText([before]).endsWith(" ")
    ) {
      node.text = node.text.replace(/^ +/u, "");
    }
  }
  return normalized;
};

/** Convert a 1-based index to a Roman numeral. */
const toRoman = (n: number): string => {
  const vals = [10, 9, 5, 4, 1] as const;
  const syms = ["X", "IX", "V", "IV", "I"] as const;
  let result = "";
  let remaining = n;
  for (let i = 0; i < vals.length; i++) {
    const value = vals.at(i);
    const symbol = syms.at(i);
    if (value === undefined || symbol === undefined) {
      continue;
    }
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }
  return result;
};

/**
 * One leaf paragraph or <div> as a chunk, its heading cues read from the
 * inline style: centring, font size, a mostly-bold run and letter spacing.
 * `null` when the block has no text.
 */
const styledBlockChunk = (
  $: cheerio.CheerioAPI,
  $el: cheerio.Cheerio<AnyNode>,
): PChunk | null => {
  const style = $el.attr("style") ?? "";
  const inlines = normalizeNssInlines(walkInlines($, $el));
  const plainText = inlinesToPlainText(inlines).trim();
  if (!plainText) {
    return null;
  }

  const boldText = visibleHtmlText(
    $el.find("span[style*='font-weight:bold']"),
  ).trim();
  return {
    inlines,
    plainText,
    centered: style.includes("text-align:center"),
    bold: boldText.length > 0 && boldText.length >= plainText.length * 0.7,
    letterSpacing:
      style.includes("letter-spacing") ||
      $el.find("span[style*='letter-spacing']").length > 0,
    fontSize: parseFontSize(style),
    listItemIndex: null,
    decimalList: false,
    footnote: footnoteOf($el),
  };
};

/**
 * Extract content chunks from the HTML body.
 * Handles <p> elements, <ol type="I"><li> ruling items, and
 * <ul><li> bullet lists (Aspose renders enumerations in the
 * reasoning, such as case-file inventories, as unordered lists).
 */
const extractChunks = ($: cheerio.CheerioAPI): PChunk[] => {
  const chunks: PChunk[] = [];

  // Skip the first-page header div (Aspose artifact)
  const body = $("body");
  body.find("div[style*='-aw-headerfooter-type']").remove();

  const blockSelector =
    "p, ol, ul, table, div, blockquote, h1, h2, h3, h4, h5, h6";
  const visitContents = ($container: cheerio.Cheerio<AnyNode>): void => {
    let run: AnyNode[] = [];
    const flush = (): void => {
      if (run.length === 0) {
        return;
      }
      const $run = $("<div></div>").append($(run).clone());
      const chunk = styledBlockChunk($, $run);
      if (chunk !== null) {
        chunks.push(chunk);
      }
      run = [];
    };
    $container.contents().each((_, child) => {
      const $child = $(child);
      if ($child.is(blockSelector) || $child.find(blockSelector).length > 0) {
        flush();
        visit(child);
        return;
      }
      run.push(child);
    });
    flush();
  };

  const visit = (el: AnyNode): void => {
    if (isComment(el)) {
      return;
    }
    const $el = $(el);
    const tag = "tagName" in el ? el.tagName.toLowerCase() : "";
    if (isExcludedHtmlTag(tag)) {
      return;
    }
    if (
      tag === "body" ||
      (tag &&
        $el.find(blockSelector).length > 0 &&
        tag !== "table" &&
        tag !== "ol" &&
        tag !== "ul")
    ) {
      visitContents($el);
      return;
    }
    if (isText(el)) {
      const plainText = el.data.trim();
      if (plainText) {
        chunks.push({
          inlines: [{ type: "text", text: plainText }],
          plainText,
          centered: false,
          bold: false,
          letterSpacing: false,
          fontSize: 12,
          listItemIndex: null,
          decimalList: false,
          footnote: null,
        });
      }
      return;
    }

    if (tag === "table") {
      $el.children("caption").each((_caption, caption) => {
        const chunk = styledBlockChunk($, $(caption));
        if (chunk !== null) {
          chunks.push(chunk);
        }
      });
      // A table whose every row is one cell lays the page out rather than
      // tabulating anything: some courts set the whole reasoning in one.
      // Its cells are read as the body is, paragraph by paragraph.
      const rows = ownTableRows($el);
      if (
        rows.length > 0 &&
        rows.toArray().every((row) => $(row).children("td, th").length === 1)
      ) {
        rows.each((_tr, trEl) => {
          visitContents($(trEl).children("td, th").first());
        });
        return;
      }
      // Extract each row as a paragraph. Cell values are
      // joined with " | " to preserve tabular structure
      // in plain text (e.g., cost breakdowns, fee summaries).
      rows.each((_tr, trEl) => {
        const cells: string[] = [];
        const cellInlines: Inline[] = [];

        $(trEl)
          .children("td, th")
          .each((_td, tdEl) => {
            const cellText = tableCellText($(tdEl));
            if (cellText) {
              cells.push(cellText);
              if (cellInlines.length > 0) {
                cellInlines.push({
                  type: "text",
                  text: " | ",
                });
              }
              cellInlines.push({
                type: "text",
                text: cellText,
              });
            }
          });

        const plainText = cells.join(" | ");
        if (!plainText) {
          return;
        }

        chunks.push({
          inlines: cellInlines,
          plainText,
          centered: false,
          bold: false,
          letterSpacing: false,
          fontSize: 12,
          listItemIndex: null,
          footnote: footnoteOf($el),
        });
      });
      return;
    }

    if (tag === "ol" || tag === "ul") {
      // Ruling items: <ol type="I"><li>... Bulleted <ul> items
      // carry no number, so they stay unnumbered chunks rather
      // than acquiring a Roman prefix the document never had.
      const ordered = tag === "ol";
      const decimalList = ordered && ($el.attr("type") ?? "1") === "1";
      const startAttr = $el.attr("start");
      let listStart = startAttr ? Number.parseInt(startAttr, 10) : 1;

      $el.contents().each((_li, liEl) => {
        if (!("tagName" in liEl) || liEl.tagName.toLowerCase() !== "li") {
          visit(liEl);
          return;
        }
        const $li = $(liEl);
        const inlines = normalizeNssInlines(walkInlines($, $li));
        const plainText = inlinesToPlainText(inlines).trim();

        if (!plainText) {
          listStart++;
          return;
        }

        chunks.push({
          inlines,
          plainText,
          centered: false,
          bold: false,
          letterSpacing: false,
          fontSize: 12,
          listItemIndex: ordered ? listStart : null,
          decimalList,
          footnote: footnoteOf($li),
        });
        listStart++;
      });
      return;
    }

    // Regular <p>
    const chunk = styledBlockChunk($, $el);
    if (chunk !== null) {
      chunks.push(chunk);
    }
  };
  visitContents(body);

  return chunks;
};

const CELL_BLOCK_SELECTOR = "p, div, li, br, h1, h2, h3, h4, h5, h6";

/**
 * The text of one table cell. The paragraphs a cell holds ("U. H.",
 * "doručovací adresa X") are words apart, as the page shows them, not run
 * together.
 */
const tableCellText = ($cell: cheerio.Cheerio<AnyNode>): string => {
  const $copy = $cell.clone();
  $copy.find(CELL_BLOCK_SELECTOR).after(" ");
  return withoutSoftHyphens(visibleHtmlText($copy))
    .replace(/\s+/gu, " ")
    .trim();
};

const parseFontSize = (style: string): number => {
  const match = /font-size:\s*(?<size>\d+)pt/u.exec(style);
  return match ? Number(match.groups?.["size"]) : 12;
};

// ── Patterns ───────────────────────────────────────────────

/**
 * Page furniture Aspose repeats at the top of every page: image placeholders
 * for the court emblem, then the running header ("pokračování 2 1 As
 * 23/2012-45", "pokračování -2- 52A 35/2012") on every page after the first.
 *
 * It is often glued to the first paragraph of the page's body rather than set
 * as its own paragraph, so the furniture is peeled off the chunk instead of
 * the chunk being dropped for starting with it. Every part is optional, so an
 * ordinary paragraph matches the empty string and is left alone.
 */
const PAGE_FURNITURE_RE = new RegExp(
  String.raw`^(?:\[OBRÁZEK\]\s*)*(?:${CZ_RUNNING_HEADER_SOURCE})?\s*`,
  "u",
);

/** Decorative lines carrying no content once the furniture is peeled. */
const DECORATIVE_LINE_RE = /^(?:pokračování|ČESKÁ REPUBLIKA)$/u;

type ChunkContent = ReturnType<typeof normalizeInlineLine>;

/**
 * Peel page furniture off a chunk, or report it as wholly decorative.
 *
 * Null means nothing but furniture was in the chunk. Anything else is body
 * text that shared a paragraph with the header, which is the common case: a
 * page opening mid-sentence carries the whole of that page's first paragraph
 * behind the emblem.
 */
const stripPageFurniture = (chunk: PChunk): ChunkContent | null => {
  const normalized = normalizeInlineLine(
    stripFurniturePrefix(chunk.inlines, PAGE_FURNITURE_RE),
  );
  const { plainText } = normalized;

  return plainText && !DECORATIVE_LINE_RE.test(plainText) ? normalized : null;
};

/**
 * Decision titles keyed by their semantic letters. Older Aspose exports split
 * one title across spans and insert ordinary or non-breaking spaces between
 * letters. Comparing the compact form keeps that presentation noise out of
 * the AST while preserving one canonical title for readers and search.
 */
const DECISION_TITLE_BY_COMPACT_TEXT = {
  ROZSUDEK: "ROZSUDEK",
  USNESENÍ: "USNESENÍ",
  JMÉNEMREPUBLIKY: "JMÉNEM REPUBLIKY",
} as const;

type CanonicalDecisionTitle =
  (typeof DECISION_TITLE_BY_COMPACT_TEXT)[keyof typeof DECISION_TITLE_BY_COMPACT_TEXT];

const isDecisionTitleKey = (
  value: string,
): value is keyof typeof DECISION_TITLE_BY_COMPACT_TEXT =>
  value in DECISION_TITLE_BY_COMPACT_TEXT;

const canonicalDecisionTitle = (
  plainText: string,
): CanonicalDecisionTitle | null => {
  const compact = normalizeUnicode(plainText, "NFKC")
    .toLocaleUpperCase("cs-CZ")
    .replace(/\s+/gu, "");

  return isDecisionTitleKey(compact)
    ? DECISION_TITLE_BY_COMPACT_TEXT[compact]
    : null;
};

/** "takto:" alone, or at the end of introductory prose. */
const TAKTO_STANDALONE_RE = /^t\s*a\s*k\s*t\s*o\s*(?::\s*)?$/iu;
const TAKTO_SUFFIX_RE = /(?:^|\s)t\s*a\s*k\s*t\s*o\s*(?::\s*)?$/iu;

/** "Odůvodnění:" separator. */
const ODUVODNENI_RE =
  /^(?:O\s*d\s*ů\s*v\s*o\s*d\s*n\s*ě\s*n\s*í|Odůvodnění)\s*(?::\s*)?$/iu;

/** "Poučení:" as standalone or inline prefix. */
const POUCENI_STANDALONE_RE =
  /^(?:P\s*o\s*u\s*č\s*e\s*n\s*í|Poučení)\s*(?::\s*)?$/iu;
const POUCENI_INLINE_RE = /^(?:P\s*o\s*u\s*č\s*e\s*n\s*í|Poučení)\s*:\s*/iu;

/**
 * Ruling item: Roman numeral + period + text.
 * Only matched in the výrok zone (before Odůvodnění).
 */
const RULING_ITEM_RE = /^(?:X{0,3}(?:IX|IV|V?I{0,3}))\.\s+(?:.+)/u;

/**
 * Section heading in Odůvodnění: Roman numeral + title text.
 * May include sub-headings like "III. A", "III. B".
 */
const SECTION_HEADING_RE =
  /^(?:X{0,3}(?:IX|IV|V?I{0,3}))\.\s*(?:[A-Z]\s+)?[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/u;

/**
 * Subsection heading in Odůvodnění: the section's Roman numeral with an
 * Arabic or a letter subsection, then a capitalised title ("IV.1 Rozhodná
 * právní úprava", "IV. 2. Judikatura", "III. a) Právní názor osmého senátu").
 */
const SUBSECTION_HEADING_RE =
  /^(?=[IVX])(?:X{0,3}(?:IX|IV|V?I{0,3}))\.\s*(?:\d{1,2}\.?|\p{Ll}\))\s*\p{Lu}/u;

/**
 * The heading of a separate opinion printed after the decision ("Odlišné
 * stanovisko soudce …"). A title, so it does not end the way a sentence
 * reporting the opinions does ("Odlišná stanoviska … uplatnili soudci …").
 */
const SEPARATE_OPINION_HEADING_RE =
  /^(?:Odlišné\s+stanovisko|Stanovisko\s+menšiny)(?:\s|:|$)/iu;
const SEPARATE_OPINION_HEADING_MAX_CHARS = 300;

const isSeparateOpinionHeading = (plainText: string): boolean =>
  plainText.length <= SEPARATE_OPINION_HEADING_MAX_CHARS &&
  SEPARATE_OPINION_HEADING_RE.test(plainText) &&
  !plainText.endsWith(".");

/** Numbered paragraph: [1], [2], ... */
const NUMBERED_PARA_RE = /^\[(?:\d+)\]\s*/u;

const DOCUMENT_PHASE = {
  PREAMBLE: "preamble",
  HOLDING: "holding",
  REASONING: "reasoning",
  INSTRUCTION: "instruction",
  /** A separate opinion, after the decision's closing and signatures. */
  SEPARATE_OPINION: "separate-opinion",
} as const;

type DocumentPhase = (typeof DOCUMENT_PHASE)[keyof typeof DOCUMENT_PHASE];

/**
 * The role of an ordinary paragraph by where it stands: the introduction
 * names the court and the parties, a separate opinion is the dissenting
 * judge's. Neither is the court's reasoning, which the court numbers.
 */
const PHASE_PARAGRAPH_ROLE = {
  [DOCUMENT_PHASE.PREAMBLE]: "intro",
  [DOCUMENT_PHASE.HOLDING]: undefined,
  [DOCUMENT_PHASE.REASONING]: undefined,
  [DOCUMENT_PHASE.INSTRUCTION]: undefined,
  [DOCUMENT_PHASE.SEPARATE_OPINION]: "dissent",
} as const satisfies Record<DocumentPhase, ParagraphBlock["role"]>;

/**
 * Closing line: "V Brně dne ...", "Praha 10. březen 2026",
 * or just "City + date" pattern.
 */
// ── Block classification ───────────────────────────────────

const makeAnchorId = (prefix: string, index: number): string =>
  `${prefix}-${index}`;

/** The phases whose ordinary paragraphs are reasoning, the court's or a judge's. */
const REASONING_PHASES: ReadonlySet<DocumentPhase> = new Set([
  DOCUMENT_PHASE.REASONING,
  DOCUMENT_PHASE.SEPARATE_OPINION,
]);

const HEADING_MAX_CHARS = 120;

/**
 * The level of a heading in the reasoning: a Roman-numbered section (3) or
 * one of its subsections ("IV.1 Rozhodná právní úprava", 4). A subsection
 * is a title, so it never ends the way a sentence does.
 */
const reasoningHeadingLevel = (plainText: string): 3 | 4 | null => {
  if (plainText.length >= HEADING_MAX_CHARS) {
    return null;
  }
  if (SECTION_HEADING_RE.test(plainText)) {
    return 3;
  }
  return SUBSECTION_HEADING_RE.test(plainText) && !plainText.endsWith(".")
    ? 4
    : null;
};

const phaseRole = (
  phase: DocumentPhase,
): Pick<ParagraphBlock, "role"> | Record<string, never> => {
  const role = PHASE_PARAGRAPH_ROLE[phase];
  return role === undefined ? {} : { role };
};

/**
 * A list item's text with the number Word prints before it: in the
 * reasoning it is the paragraph's number ("1. Napadeným …").
 */
const withListMarker = (
  chunk: PChunk,
  { inlines, plainText }: ChunkContent,
): { inlines: Inline[]; plainText: string } => {
  if (!chunk.decimalList || chunk.listItemIndex === null) {
    return { inlines, plainText };
  }
  const marker = `${String(chunk.listItemIndex)}. `;
  return {
    inlines: [{ type: "text", text: marker }, ...inlines],
    plainText: `${marker}${plainText}`,
  };
};

/**
 * Append a chunk to the reasoning paragraph a page break cut, when the chunk
 * is the rest of its sentence. Reports whether it did.
 */
const finishesCutParagraph = (
  cut: ParagraphBlock | null,
  chunk: PChunk,
  { inlines, plainText }: ChunkContent,
): boolean => {
  if (
    cut === null ||
    chunk.footnote !== null ||
    chunk.listItemIndex !== null ||
    !continuesAcrossPageBreak(cut.plainText, plainText)
  ) {
    return false;
  }
  cut.inlines.push({ type: "text", text: " " }, ...inlines);
  cut.plainText = `${cut.plainText} ${plainText}`;
  return true;
};

/**
 * Strip a character-counted prefix from inlines.
 * Unlike a naive approach, this correctly handles bold,
 * italic, and other wrapper nodes by recursively counting
 * their text content.
 */
const classifyChunks = (chunks: readonly PChunk[]): Block[] => {
  let blockCounter = 0;
  const makeBlockId = (): string => {
    blockCounter += 1;
    return `b${blockCounter}`;
  };
  const blocks: Block[] = [];
  let blockIndex = 0;

  let phase: DocumentPhase = DOCUMENT_PHASE.PREAMBLE;
  const footnoteOccurrences = new Map<string, number>();
  let sawCaseNumber = false;
  let sawTitle = false;
  let sawClosing = false;
  /**
   * The reasoning paragraph just emitted, which the next chunk may finish:
   * a page break cuts a paragraph in two, sometimes behind a running header.
   */
  let cutParagraph: ParagraphBlock | null = null;

  for (const chunk of chunks) {
    const { centered, bold, letterSpacing: _letterSpacing } = chunk;

    const content = stripPageFurniture(chunk);
    if (content === null) {
      continue;
    }
    const { plainText, inlines } = content;
    const continuing = cutParagraph;
    cutParagraph = null;

    if (finishesCutParagraph(continuing, chunk, content)) {
      cutParagraph = continuing;
      continue;
    }

    if (chunk.footnote !== null) {
      // A footnote the publisher set over several paragraphs arrives as
      // several chunks of one container. Every part keeps the container's
      // id as its `noteId` and repeats the label, so the reader groups
      // them; only the first part owns the container's own anchor, which
      // is what the in-text reference links to.
      const occurrence =
        (footnoteOccurrences.get(chunk.footnote.anchorId) ?? 0) + 1;
      footnoteOccurrences.set(chunk.footnote.anchorId, occurrence);
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId:
          occurrence === 1
            ? chunk.footnote.anchorId
            : `${chunk.footnote.anchorId}-${occurrence}`,
        type: "paragraph",
        note: {
          type: "footnote",
          label: chunk.footnote.label,
          noteId: chunk.footnote.anchorId,
        },
        inlines,
        plainText,
      });
      continue;
    }

    const decisionTitle = canonicalDecisionTitle(plainText);

    // Case number: first content before the title, centered
    // Case number line (e.g. "2 As 3/2025 - 56")
    if (
      !sawTitle &&
      centered &&
      decisionTitle === null &&
      !sawCaseNumber &&
      /\d/u.test(plainText)
    ) {
      sawCaseNumber = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "case-number",
        inlines,
        plainText,
      });
      continue;
    }

    // Decision title: ROZSUDEK, USNESENÍ, JMÉNEM REPUBLIKY
    if (decisionTitle !== null) {
      sawTitle = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 1,
        role: "decision-title",
        inlines: [{ type: "text", text: decisionTitle }],
        plainText: decisionTitle,
      });
      continue;
    }

    // "takto:" separator (centered, bold, letter-spaced)
    if (
      phase === DOCUMENT_PHASE.PREAMBLE &&
      TAKTO_STANDALONE_RE.test(plainText)
    ) {
      phase = DOCUMENT_PHASE.HOLDING;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: [{ type: "text", text: "takto:" }],
        plainText: "takto:",
      });
      continue;
    }

    // Some exports keep the introductory sentence and separator in one
    // paragraph. Preserve that prose as prose, then open the same structural
    // zone for the ordered or unnumbered holdings that follow it.
    if (phase === DOCUMENT_PHASE.PREAMBLE && TAKTO_SUFFIX_RE.test(plainText)) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "intro",
        inlines,
        plainText,
      });
      phase = DOCUMENT_PHASE.HOLDING;
      continue;
    }

    // "Odůvodnění:" separator
    if (ODUVODNENI_RE.test(plainText)) {
      phase = DOCUMENT_PHASE.REASONING;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: [{ type: "text", text: "Odůvodnění:" }],
        plainText: "Odůvodnění:",
      });
      continue;
    }

    // "Poučení:" standalone
    if (POUCENI_STANDALONE_RE.test(plainText)) {
      phase = DOCUMENT_PHASE.INSTRUCTION;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: [{ type: "text", text: "Poučení:" }],
        plainText: "Poučení:",
      });
      continue;
    }

    // "Poučení:" inline (bold prefix + text in same <p>)
    if (POUCENI_INLINE_RE.test(plainText) && bold) {
      phase = DOCUMENT_PHASE.INSTRUCTION;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: [{ type: "text", text: "Poučení:" }],
        plainText: "Poučení:",
      });

      // The rest is the poučení text
      const pouceniMatch = POUCENI_INLINE_RE.exec(plainText);
      if (pouceniMatch) {
        const rest = plainText.slice(pouceniMatch[0].length).trim();
        if (rest) {
          blockIndex += 1;
          blocks.push({
            id: makeBlockId(),
            anchorId: makeAnchorId("p", blockIndex),
            type: "paragraph",
            inlines: [{ type: "text", text: rest }],
            plainText: rest,
          });
        }
      }
      continue;
    }

    // A line the court numbered ("[3] Věc projednal senát …") is body text,
    // never a closing or a signature, however it reads: classifying it away
    // would leave a gap in the court's numbering.
    const courtNumbered = opensWithCourtParagraphMarker(plainText);

    // A separate opinion follows the decision's closing; its paragraphs are
    // the dissenting judge's, numbered from 1 again.
    if (sawClosing && isSeparateOpinionHeading(plainText)) {
      phase = DOCUMENT_PHASE.SEPARATE_OPINION;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines,
        plainText,
      });
      continue;
    }

    // Closing: "V Brně dne ..."
    if (!courtNumbered && CLOSING_RE.test(plainText)) {
      sawClosing = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "closing",
        inlines,
        plainText,
      });
      continue;
    }

    // Signature: judge title (short, centered lines only)
    if (
      !courtNumbered &&
      SIGNATURE_RE.test(plainText) &&
      plainText.length < 80
    ) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "signature",
        inlines,
        plainText,
      });
      continue;
    }

    // Judge name: short centered text right before signature
    // (check next chunk for signature pattern)
    if (
      centered &&
      plainText.length < 60 &&
      phase !== DOCUMENT_PHASE.INSTRUCTION &&
      chunks.indexOf(chunk) < chunks.length - 1
    ) {
      const nextChunk = chunks[chunks.indexOf(chunk) + 1];
      if (nextChunk && SIGNATURE_RE.test(nextChunk.plainText)) {
        blockIndex += 1;
        blocks.push({
          id: makeBlockId(),
          anchorId: makeAnchorId("p", blockIndex),
          type: "paragraph",
          role: "signature",
          inlines,
          plainText,
        });
        continue;
      }
    }

    // <ol> list items: holding paragraphs before Odůvodnění,
    // numbered paragraphs after
    if (chunk.listItemIndex !== null) {
      if (phase === DOCUMENT_PHASE.HOLDING) {
        // Reconstruct the full text with Roman numeral prefix
        const roman = `${toRoman(chunk.listItemIndex)}.`;
        const fullInlines: Inline[] = [
          { type: "text", text: `${roman} ` },
          ...inlines,
        ];
        const fullPlain = `${roman} ${plainText}`;
        blockIndex += 1;
        blocks.push({
          id: makeBlockId(),
          anchorId: makeAnchorId("p", blockIndex),
          type: "paragraph",
          role: "holding",
          inlines: fullInlines,
          plainText: fullPlain,
        });
      } else {
        blockIndex += 1;
        blocks.push({
          id: makeBlockId(),
          anchorId: makeAnchorId("p", blockIndex),
          type: "paragraph",
          ...phaseRole(phase),
          ...withListMarker(chunk, content),
        });
      }
      continue;
    }

    // A numbered paragraph starts reasoning even when the publisher omitted
    // or misspelled its separator. Keep the phase transition durable so later
    // unnumbered reasoning cannot leak back into the holding section.
    if (phase === DOCUMENT_PHASE.HOLDING && NUMBERED_PARA_RE.test(plainText)) {
      phase = DOCUMENT_PHASE.REASONING;
    }

    // A single unnumbered výrok is a regular paragraph in Aspose HTML.
    // Its position, between the two structural separators, is definitive.
    if (phase === DOCUMENT_PHASE.HOLDING) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "holding",
        inlines,
        plainText,
      });
      continue;
    }

    // Ruling items by text pattern (before Odůvodnění):
    // detected by Roman numeral prefix, emitted as holding
    // paragraphs with the full original text preserved.
    if (phase === DOCUMENT_PHASE.PREAMBLE && RULING_ITEM_RE.test(plainText)) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "holding",
        inlines,
        plainText,
      });
      continue;
    }

    const reasoning = REASONING_PHASES.has(phase);

    const headingLevel = reasoning ? reasoningHeadingLevel(plainText) : null;
    if (headingLevel !== null) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: headingLevel,
        inlines,
        plainText,
      });
      continue;
    }

    // A numbered paragraph ("[1] …") stays whole here: whether its marker is
    // the court's numbering is decided over the whole decision, by
    // `courtParagraphNumbers` once every block is classified.
    // Default: paragraph
    blockIndex += 1;
    const paragraph: ParagraphBlock = {
      id: makeBlockId(),
      anchorId: makeAnchorId("p", blockIndex),
      type: "paragraph",
      ...phaseRole(phase),
      inlines,
      plainText,
    };
    blocks.push(paragraph);
    if (reasoning) {
      cutParagraph = paragraph;
    }
  }

  return blocks;
};
