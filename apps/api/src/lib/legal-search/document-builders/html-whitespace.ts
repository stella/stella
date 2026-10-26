// parser-output-unchanged: adds `renderHtmlWhiteSpace` and `isHtmlBlock`, which read a parsed document; `collapseHtmlWhitespace` is unchanged, and only the Polish courts reader calls the new functions.
import { panic } from "better-result";
import {
  type AnyNode,
  type Element,
  hasChildren,
  isTag,
  isText,
  type Text,
} from "domhandler";

import type { Inline } from "@stll/legal-ast/document-ast";

import { isExcludedHtmlTag } from "@/api/lib/legal-search/parsers/visible-html-text";

import { inlineStyleValue } from "./inline-style";

/** The whitespace HTML collapses. A no-break space is text and stays. */
const HTML_WHITESPACE = /[ \t\n\r\f]+/gu;

type CollapseState = { afterSpace: boolean };

const collapseRun = (
  inlines: readonly Inline[],
  state: CollapseState,
): Inline[] => {
  const out: Inline[] = [];
  for (const inline of inlines) {
    switch (inline.type) {
      case "text": {
        let text = inline.text.replace(HTML_WHITESPACE, " ");
        if (state.afterSpace && text.startsWith(" ")) {
          text = text.slice(1);
        }
        if (text === "") {
          break;
        }
        state.afterSpace = text.endsWith(" ");
        out.push({ ...inline, text });
        break;
      }
      case "line-break": {
        out.push(inline);
        state.afterSpace = true;
        break;
      }
      case "page-anchor": {
        out.push(inline);
        break;
      }
      case "bold":
      case "italic":
      case "underline":
      case "superscript":
      case "subscript":
      case "link":
      case "citation": {
        const children = collapseRun(inline.children, state);
        if (children.length > 0) {
          out.push({ ...inline, children });
        }
        break;
      }
      default: {
        inline satisfies never;
        panic(`Unhandled inline: ${String(inline)}`);
      }
    }
  }
  return out;
};

/** `inlines` with their last text leaf's trailing whitespace removed. */
const trimEnd = (inlines: readonly Inline[]): Inline[] => {
  const last = inlines.at(-1);
  if (last === undefined) {
    return [];
  }
  const head = inlines.slice(0, -1);
  if (last.type === "text") {
    const text = last.text.endsWith(" ") ? last.text.slice(0, -1) : last.text;
    return text === "" ? trimEnd(head) : [...head, { ...last, text }];
  }
  if (last.type === "line-break" || last.type === "page-anchor") {
    return [...head, last];
  }
  const children = trimEnd(last.children);
  return children.length === 0
    ? trimEnd(head)
    : [...head, { ...last, children }];
};

/**
 * An inline run with whitespace as a browser renders it: every run of
 * source whitespace one space, none at the start, after a line break, or at
 * the end, across element boundaries. The source's line breaks and
 * indentation are markup, not text, and must not reach the text axis.
 */
export const collapseHtmlWhitespace = (inlines: readonly Inline[]): Inline[] =>
  trimEnd(collapseRun(inlines, { afterSpace: true }));

/**
 * How a CSS `white-space` value treats the source's whitespace: collapsed to
 * single spaces, kept as written, or kept only at its line breaks.
 */
const WHITE_SPACE = {
  COLLAPSE: "collapse",
  PRESERVE: "preserve",
  PRESERVE_BREAKS: "preserve-breaks",
} as const;

type WhiteSpace = (typeof WHITE_SPACE)[keyof typeof WHITE_SPACE];

const WHITE_SPACE_VALUES: Readonly<Record<string, WhiteSpace>> = {
  normal: WHITE_SPACE.COLLAPSE,
  nowrap: WHITE_SPACE.COLLAPSE,
  initial: WHITE_SPACE.COLLAPSE,
  pre: WHITE_SPACE.PRESERVE,
  "pre-wrap": WHITE_SPACE.PRESERVE,
  "break-spaces": WHITE_SPACE.PRESERVE,
  "pre-line": WHITE_SPACE.PRESERVE_BREAKS,
};

/** Elements a browser's own style sheet sets `white-space: pre`. */
const PREFORMATTED_TAGS: ReadonlySet<string> = new Set([
  "pre",
  "listing",
  "plaintext",
  "xmp",
  "textarea",
]);

/** Elements a browser lays out as blocks: a line ends at either edge. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** CSS `display` outer types that lay an element out as a block. */
const BLOCK_DISPLAYS: ReadonlySet<string> = new Set([
  "block",
  "flex",
  "flow-root",
  "grid",
  "list-item",
  "table",
  "table-caption",
  "table-cell",
  "table-footer-group",
  "table-header-group",
  "table-row",
  "table-row-group",
]);

/** CSS `display` values that keep an element in its line. */
const INLINE_DISPLAYS: ReadonlySet<string> = new Set([
  "contents",
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "inline-table",
  "none",
  "ruby",
]);

/**
 * Whether a browser lays an element out as a block, so that a line ends at
 * either edge: its inline `display` where the cascade picks one this reader
 * knows (`display: inline` makes a `<div>` part of its line), its tag's
 * default otherwise.
 */
export const isHtmlBlock = (element: Element): boolean =>
  inlineStyleValue(element, (property, value) => {
    if (property !== "display") {
      return undefined;
    }
    // Two-keyword values name the outer type first or alone (`inline flow-root`).
    const parts = value.split(/\s+/u);
    if (parts.includes("inline") || INLINE_DISPLAYS.has(value)) {
      return { value: false };
    }
    return parts.some((part) => BLOCK_DISPLAYS.has(part))
      ? { value: true }
      : undefined;
  })?.value ?? BLOCK_TAGS.has(element.tagName.toLowerCase());

/** The `white-space` an element sets, or undefined where it inherits. */
const ownWhiteSpace = (element: Element): WhiteSpace | undefined =>
  inlineStyleValue(element, (property, value) => {
    const mode =
      property === "white-space" && Object.hasOwn(WHITE_SPACE_VALUES, value)
        ? WHITE_SPACE_VALUES[value]
        : undefined;
    return mode === undefined ? undefined : { value: mode };
  })?.value ??
  (PREFORMATTED_TAGS.has(element.tagName.toLowerCase())
    ? WHITE_SPACE.PRESERVE
    : undefined);

type WhiteSpaceFrame =
  | { type: "node"; node: AnyNode; whiteSpace: WhiteSpace }
  | { type: "block-end" };

/**
 * Rewrite a parsed document's text, in place, as a browser renders its
 * whitespace. Under `white-space: normal` every run of source whitespace
 * becomes one space, none at the start or end of a line, across element
 * boundaries; under `pre`, `pre-wrap` and `break-spaces` (and inside `<pre>`)
 * the text is kept as written; under `pre-line` its line breaks are kept and
 * the rest collapses. A block's edge ends a line, so the text before it ends
 * in a `\n` (`<td><p>a</p><p>b</p></td>` reads `a\nb`). Every line break
 * stays a `\n` in the text, for the reader to turn into a line break, and
 * words are never joined, so a later reading of the same document finds the
 * same words.
 */
export const renderHtmlWhiteSpace = (root: AnyNode): void => {
  // At a line start, or after a collapsible space: a collapsible space here
  // renders as nothing.
  let afterSpace = true;
  // The last text on the current line.
  let last: { node: Text; whiteSpace: WhiteSpace } | undefined;
  // A line ends: its trailing collapsible space goes, and where a block edge
  // ends it, a line break takes its place.
  const endLine = (atBlockEdge: boolean): void => {
    if (last !== undefined) {
      const { node, whiteSpace } = last;
      if (whiteSpace !== WHITE_SPACE.PRESERVE && node.data.endsWith(" ")) {
        node.data = node.data.slice(0, -1);
      }
      if (atBlockEdge && !node.data.endsWith("\n")) {
        node.data += "\n";
      }
    }
    last = undefined;
    afterSpace = true;
  };
  const renderText = (node: Text, whiteSpace: WhiteSpace): void => {
    let text = node.data.replaceAll(/\r\n?/gu, "\n");
    if (whiteSpace === WHITE_SPACE.COLLAPSE) {
      text = text.replace(HTML_WHITESPACE, " ");
    } else {
      // A kept line break ends the line before it.
      if (text.startsWith("\n")) {
        endLine(false);
      }
      if (whiteSpace === WHITE_SPACE.PRESERVE_BREAKS) {
        text = text
          .replaceAll(/[ \t\f]+/gu, " ")
          .replaceAll(" \n", "\n")
          .replaceAll("\n ", "\n");
      }
    }
    if (whiteSpace !== WHITE_SPACE.PRESERVE && afterSpace) {
      text = text.replace(/^ /u, "");
    }
    node.data = text;
    if (text === "") {
      return;
    }
    if (text.endsWith("\n")) {
      last = undefined;
      afterSpace = true;
      return;
    }
    last = { node, whiteSpace };
    afterSpace = whiteSpace !== WHITE_SPACE.PRESERVE && text.endsWith(" ");
  };

  const pending: WhiteSpaceFrame[] = [
    { type: "node", node: root, whiteSpace: WHITE_SPACE.COLLAPSE },
  ];
  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    if (frame.type === "block-end") {
      endLine(true);
      continue;
    }
    const { node } = frame;
    if (isText(node)) {
      renderText(node, frame.whiteSpace);
      continue;
    }
    if (!hasChildren(node)) {
      continue;
    }
    let { whiteSpace } = frame;
    if (isTag(node)) {
      const tag = node.tagName.toLowerCase();
      if (isExcludedHtmlTag(tag)) {
        continue;
      }
      if (tag === "br") {
        endLine(false);
        continue;
      }
      whiteSpace = ownWhiteSpace(node) ?? whiteSpace;
      if (isHtmlBlock(node)) {
        endLine(true);
        pending.push({ type: "block-end" });
      }
    }
    for (const child of node.children.toReversed()) {
      pending.push({ type: "node", node: child, whiteSpace });
    }
  }
  endLine(false);
};
