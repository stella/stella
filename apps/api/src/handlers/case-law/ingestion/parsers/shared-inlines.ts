// parser-output-unchanged: visible text walks the same nodes in the same order and skips the same script/style subtrees; inline and visible text output is unchanged.
// parser-output-unchanged: `<sup>` becomes a superscript only under the opt-in `superscripts` option; every walk without it unwraps it as before.
// parser-output-unchanged: exports the existing script/style exclusion as a selector so pl-tk can clean its owned DOM clone once; other parsers keep using the unchanged tag predicate.
// parser-output-unchanged: [cz-regional] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [sk-courts] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [sk-us] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [pl-sn] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [pl-nsa] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-courts] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-vfgh] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-vwgh] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-bvwg] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-lvwg] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-asylgh] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-ubas] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-uvs] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-verg] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-umse] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [at-bks] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [hu-bhgy] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [pl-uodo] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
// parser-output-unchanged: [us-courtlistener] The new legacy quarantine projection is unused by this source; existing inline and visible text output is unchanged.
/**
 * Shared inline-tree utilities for case-law HTML parsers.
 *
 * Every HTML court parser (cz-ns, cz-nss, cz-us, pl-courts) walks a
 * cheerio DOM into the canonical `Inline[]` tree, flattens that tree to
 * plain text, and strips a leading character prefix while preserving
 * nested formatting. These operations were duplicated per parser (with
 * `stripInlinePrefix` byte-for-byte identical between cz-nss and cz-us).
 * The genuine per-court differences — link sanitization and Aspose
 * `<span>`/`<img>` handling — are expressed as options so each parser
 * keeps a thin local alias over one core.
 */

import type * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

// parser-output-unchanged: imports the document AST from its package owner
import type { Inline } from "@stll/legal-ast/document-ast";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";
// parser-output-unchanged: the inline-line helpers moved unchanged to their package owner so library parsers can import them.
import { stripInlinePrefix } from "@stll/legal-ast/inline-line";

// parser-output-unchanged: the visible-text helpers moved unchanged to visible-html-text.ts so AST validation can reuse them without importing the parser module.
import {
  EXCLUDED_HTML_SELECTOR,
  isExcludedHtmlTag,
  visibleHtmlText,
} from "@/api/lib/legal-search/parsers/visible-html-text";

export { EXCLUDED_HTML_SELECTOR, isExcludedHtmlTag, visibleHtmlText };

/** Repair-only projection for quarantine identities stored before visible text. */
export const legacyQuarantineHtmlText = (
  el: cheerio.Cheerio<AnyNode>,
): string => el.text();

/** Nested table text belongs to the outer cell's inline tree, once. */
export const ownTableRows = (table: cheerio.Cheerio<AnyNode>) =>
  table
    .children("tr")
    .add(table.children("thead, tbody, tfoot").children("tr"));

/**
 * Append text to an inline list, dropping empty strings and coalescing
 * with the previous text node when their anonymization state matches.
 * Merging keeps the AST canonical (no redundant adjacent text nodes)
 * and ensures consecutive anonymized fragments render as a single
 * bracketed span. Plain-text output is identical either way, so search,
 * AI, citation extraction, and the AST validator are unaffected.
 */
export const appendTextInline = (
  target: Inline[],
  text: string,
  anonymized = false,
): void => {
  if (!text) {
    return;
  }

  const last = target.at(-1);
  if (
    last?.type === "text" &&
    last.anonymized === (anonymized ? true : undefined)
  ) {
    last.text += text;
    return;
  }

  target.push({
    type: "text",
    text,
    ...(anonymized && { anonymized: true as const }),
  });
};

/**
 * What a whitespace-only Aspose spacer span contributes to the inline
 * tree. The span's own glyphs do not encode the gap it paints — the
 * width lives in CSS (`width:36pt`) or in an `&nbsp;` run of arbitrary
 * length — so every such span yields the same canonical gap.
 *
 * Two characters, because cz-nss's letter-spacing reassembly reads one
 * space as a letter separator and two or more as a word boundary. Both
 * are U+00A0 rather than U+0020: HTML collapses runs of ordinary
 * whitespace, so an ordinary-space gap would be indistinguishable from
 * the indentation a pretty-printed export puts between two spans. Every
 * consumer folds the pair back to a single space through
 * `collapseSpacedLetters`.
 */
export const ASPOSE_SPACER_GAP = "\u00a0\u00a0";

/**
 * Class marking content the publisher anonymized. Everything inside the
 * element carries the flag, so a parser reading a subtree whose walk
 * starts below the marked element has to seed the state itself.
 */
export const ANONYMIZED_CLASS = "anon-block";

export type WalkInlinesOptions = {
  /**
   * Map/validate `<a>` hrefs (e.g. `sanitizeUrl`, which returns
   * `undefined` for unsafe URLs). When omitted the raw `href` attribute
   * is kept verbatim.
   */
  sanitizeHref?: (href: string) => string | undefined;
  /** Emit `<img alt="...">` text as a text inline (Aspose headers). */
  parseImgAlt?: boolean;
  /**
   * Read emphasis from `<span style="font-weight/-style">` and skip
   * Aspose spacer spans (NSS Aspose.Words HTML).
   */
  parseSpanStyle?: boolean;
  /** Seed the anonymization flag for the whole subtree (pl-courts). */
  anonymized?: boolean;
  /**
   * Read emphasis from class names rather than tags or inline styles.
   * Cellar's `coj-*` XHTML marks every emphasis with a class on a
   * presentational `<span>` (`coj-bold`, `coj-italic`) and carries no
   * style attributes at all.
   */
  emphasisClasses?: { bold: readonly string[]; italic: readonly string[] };
  /**
   * Read an element as a publisher page boundary. An element it answers
   * for becomes that zero-width anchor, and its printed label leaves the
   * text axis; any other element is walked as usual.
   */
  pageAnchor?: (element: Element) => InlinePageAnchor | undefined;
  /**
   * Read `<sup>` as a superscript inline. Off, its text is unwrapped onto
   * the baseline as before; a publisher whose markup states superscripts
   * the reader should show opts in.
   */
  superscripts?: boolean;
};

type InlinePageAnchor = Extract<Inline, { type: "page-anchor" }>;

export const walkInlines = (
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
  options: WalkInlinesOptions = {},
): Inline[] => {
  const walk = (
    node: cheerio.Cheerio<AnyNode>,
    anonymized: boolean,
  ): Inline[] => {
    const inlines: Inline[] = [];

    node.contents().each((_, child) => {
      if (isText(child)) {
        appendTextInline(inlines, $(child).text(), anonymized);
        return;
      }

      if (!isTag(child)) {
        return;
      }

      const tag = child.tagName.toLowerCase();
      // isTag() also matches <script>/<style>; never emit their raw text.
      if (isExcludedHtmlTag(tag)) {
        return;
      }

      const anchor = options.pageAnchor?.(child);
      if (anchor !== undefined) {
        // A page label can own the only separator between its neighbours.
        // Preserve its boundary whitespace, but never split a word it bisects.
        const printed = $(child).text();
        const leading = /^\s+/u.exec(printed)?.at(0) ?? "";
        const afterLeading = printed.slice(leading.length);
        const trailing = afterLeading.slice(afterLeading.trimEnd().length);
        appendTextInline(inlines, leading, anonymized);
        inlines.push(anchor);
        appendTextInline(inlines, trailing, anonymized);
        return;
      }

      const $child = $(child);
      const childAnon = anonymized || $child.hasClass(ANONYMIZED_CLASS);

      if (tag === "br") {
        inlines.push({ type: "line-break" });
        return;
      }

      if (options.parseImgAlt && tag === "img") {
        const alt = $child.attr("alt")?.trim();
        if (alt) {
          appendTextInline(inlines, alt, childAnon);
        }
        return;
      }

      if (options.parseSpanStyle && tag === "span") {
        const style = $child.attr("style") ?? "";

        // Aspose spacer spans carry horizontal space rather than words:
        // tab stops, alignment fills, and the gap between two
        // letter-spaced words. Emit that gap instead of dropping the
        // span; dropping it welds the neighbouring words together and
        // leaves the letter-spacing reassembly to guess a boundary that
        // is no longer in the text. Older conversions sometimes put real
        // words inside these spans, so only whitespace-only spans become
        // a gap.
        if (
          style.includes("-aw-import:ignore") ||
          style.includes("-aw-import:spaces") ||
          style.includes("display:inline-block")
        ) {
          const innerText = $child.text().trim();
          if (!innerText) {
            appendTextInline(inlines, ASPOSE_SPACER_GAP, childAnon);
            return;
          }
        }

        const isBold = style.includes("font-weight:bold");
        const isItalic = style.includes("font-style:italic");
        const children = walk($child, childAnon);
        if (children.length === 0) {
          return;
        }

        if (isBold && isItalic) {
          inlines.push({
            type: "bold",
            children: [{ type: "italic", children }],
          });
        } else if (isBold) {
          inlines.push({ type: "bold", children });
        } else if (isItalic) {
          inlines.push({ type: "italic", children });
        } else {
          inlines.push(...children);
        }
        return;
      }

      if (options.superscripts === true && tag === "sup") {
        const children = walk($child, childAnon);
        if (children.length > 0) {
          inlines.push({ type: "superscript", children });
        }
        return;
      }

      if (tag === "b" || tag === "strong") {
        const children = walk($child, childAnon);
        if (children.length > 0) {
          inlines.push({ type: "bold", children });
        }
        return;
      }

      if (tag === "i" || tag === "em") {
        const children = walk($child, childAnon);
        if (children.length > 0) {
          inlines.push({ type: "italic", children });
        }
        return;
      }

      if (tag === "a") {
        const rawHref = $child.attr("href");
        const href = options.sanitizeHref
          ? options.sanitizeHref(rawHref ?? "")
          : rawHref;
        const children = walk($child, childAnon);
        if (href && children.length > 0) {
          inlines.push({ type: "link", href, children });
        } else if (children.length > 0) {
          inlines.push(...children);
        }
        return;
      }

      if (options.emphasisClasses) {
        const isBold = options.emphasisClasses.bold.some((name) =>
          $child.hasClass(name),
        );
        const isItalic = options.emphasisClasses.italic.some((name) =>
          $child.hasClass(name),
        );
        if (isBold || isItalic) {
          const children = walk($child, childAnon);
          if (children.length === 0) {
            return;
          }
          if (isBold && isItalic) {
            inlines.push({
              type: "bold",
              children: [{ type: "italic", children }],
            });
          } else if (isBold) {
            inlines.push({ type: "bold", children });
          } else {
            inlines.push({ type: "italic", children });
          }
          return;
        }
      }

      // Unwrap presentational wrappers.
      inlines.push(...walk($child, childAnon));
    });

    return inlines;
  };

  return walk(el, options.anonymized ?? false);
};

export const inlinesToPlainText = (inlines: readonly Inline[]): string => {
  let text = "";
  for (const node of inlines) {
    if (node.type === "text") {
      text += node.text;
    } else if (node.type === "line-break") {
      text += "\n";
    } else if (hasInlineChildren(node)) {
      text += inlinesToPlainText(node.children);
    }
  }
  return text;
};

/**
 * Strip a leading run of presentational page furniture, matched by `pattern`
 * against the chunk's own plain text.
 *
 * Aspose glues a page's running header onto the first paragraph of that
 * page's body, so a chunk that *starts* with furniture usually carries body
 * text behind it. Peeling the prefix and letting the caller judge the
 * remainder keeps that text, where testing the whole chunk against the same
 * pattern and dropping it loses the page. `pattern` is matched from the first
 * non-whitespace character, so it anchors with `^` and needs no allowance for
 * the leading whitespace an inline walk may leave.
 */
export const stripFurniturePrefix = (
  inlines: readonly Inline[],
  pattern: RegExp,
): Inline[] => {
  const text = inlinesToPlainText(inlines);
  const lead = text.length - text.trimStart().length;
  const match = pattern.exec(text.slice(lead))?.at(0);

  return match === undefined || match.length === 0
    ? [...inlines]
    : stripInlinePrefix(inlines, lead + match.length);
};
