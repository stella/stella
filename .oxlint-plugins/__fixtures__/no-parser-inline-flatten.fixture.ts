import type { Inline } from "@stll/legal-ast/inline";
import { flattenInlineText } from "@stll/legal-ast/inline";
import { plainTextOf } from "@stll/legal-ast/document-ast";

export const recursiveProjection = (inlines: readonly Inline[]): string => {
  let text = "";
  for (const node of inlines) {
    if (node.type === "text") {
      // oxlint-disable-next-line no-parser-inline-flatten/no-parser-inline-flatten -- Positive fixture: the former parser projection silently joined superscript digits.
      text += node.text;
    } else if ("children" in node) {
      text += recursiveProjection(node.children);
    }
  }
  return text;
};

export const mappingProjection = (inlines: Inline[]): string =>
  inlines
    .filter((node) => node.type === "text")
    // oxlint-disable-next-line no-parser-inline-flatten/no-parser-inline-flatten -- Positive fixture: a map-based leaf projection has the same superscript loss.
    .map(({ text }) => text)
    .join("");

// expect-clean: no-parser-inline-flatten/no-parser-inline-flatten
export const canonicalProjection = (inlines: readonly Inline[]): string =>
  flattenInlineText(inlines);

// expect-clean: no-parser-inline-flatten/no-parser-inline-flatten
export const rendererAxis = (inlines: readonly Inline[]): string => plainTextOf(inlines);

// expect-clean: no-parser-inline-flatten/no-parser-inline-flatten
export const transform = (inlines: Inline[]): Inline[] =>
  inlines.map((node) => (node.type === "text" ? { type: "text", text: node.text.trim() } : node));
