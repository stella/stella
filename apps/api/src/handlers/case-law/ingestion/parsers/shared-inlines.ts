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
import { type AnyNode, isTag, isText } from "domhandler";

import type { Inline } from "@/api/handlers/case-law/document-ast";

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
};

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
      if (tag === "script" || tag === "style") {
        return;
      }

      const $child = $(child);
      const childAnon = anonymized || $child.hasClass("anon-block");

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

        // Skip Aspose spacer spans only when they contain no meaningful
        // text. Modern exports use these for tab stops and invisible
        // fills, but older conversions sometimes place real words inside.
        if (
          style.includes("-aw-import:ignore") ||
          style.includes("-aw-import:spaces") ||
          style.includes("display:inline-block")
        ) {
          const innerText = $child.text().trim();
          if (!innerText) {
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
    } else {
      // bold | italic | link — all carry children
      text += inlinesToPlainText(node.children);
    }
  }
  return text;
};

export const stripInlinePrefix = (
  inlines: readonly Inline[],
  charCount: number,
): Inline[] => {
  if (charCount <= 0) {
    return [...inlines];
  }

  const result: Inline[] = [];
  let remaining = charCount;

  for (const node of inlines) {
    if (remaining <= 0) {
      result.push(node);
      continue;
    }

    if (node.type === "text") {
      if (node.text.length <= remaining) {
        remaining -= node.text.length;
      } else {
        const rest = node.text.slice(remaining);
        remaining = 0;
        if (rest) {
          result.push({ ...node, text: rest });
        }
      }
      continue;
    }

    if (node.type === "line-break") {
      remaining -= 1;
      continue;
    }

    // Remaining variants (bold | italic | link) all carry children.
    const nodeTextLen = inlinesToPlainText(node.children).length;
    if (nodeTextLen <= remaining) {
      // Entire node consumed by prefix
      remaining -= nodeTextLen;
    } else {
      // Partial strip inside the node
      const stripped = stripInlinePrefix(node.children, remaining);
      remaining = 0;
      if (stripped.length > 0) {
        result.push({ ...node, children: stripped });
      }
    }
  }

  // Trim leading whitespace from the first text node
  const first = result[0];
  if (result.length > 0 && first?.type === "text") {
    const trimmed = first.text.trimStart();
    if (trimmed) {
      result[0] = { ...first, text: trimmed };
    } else {
      result.shift();
    }
  }

  return result;
};
