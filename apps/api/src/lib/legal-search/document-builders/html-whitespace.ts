import { panic } from "better-result";

import type { Inline } from "@stll/legal-ast/document-ast";

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
