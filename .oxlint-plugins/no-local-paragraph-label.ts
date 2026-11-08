// A printed paragraph label (`12.`, `[12]`, `5.5.`, `(3)`, `a)`) is read in
// one place: the printed-label grammar in @stll/legal-ast
// (packages/legal-ast/src/printed-paragraph-labels.ts), which decides both
// what label a line opens with and whether it opens a paragraph after the
// line above (never inside a wrapped date, never after `písm.` or `art.`).
// A parser that matches labels with a regular expression of its own opens
// paragraphs at dates and citations the grammar continues, or welds the
// sub-paragraphs it does not know. Syntax only: a regular expression whose
// source anchors at a line start and opens with a number closed the way a
// label is (`^\d{1,3}\.`, `^\(?\d{1,3}[.)]`, `^\[\d{1,4}\]`), in a regex
// literal or a `RegExp` string argument.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode } from "./utils.ts";

/** A line start, perhaps after spaces, a group and an opening bracket. */
const OPENING = String.raw`^\^(?:\\s[*+?]?|\[[^\]]*\][*+?]?)?(?:\\\(\??|\\\[)?(?:\(\?:|\((?:\?<\w+>)?)?(?:\\\(\??|\\\[)?`;
/** A run of digits: `\d{1,3}`, `\d+`, `[0-9]{1,2}`. */
const NUMBER = String.raw`(?:\\d|\[0-9\])(?:\{1,\d\}|\+)\)?`;
/** What closes a label: a dot, a parenthesis, a bracket, a sub-number's dot. */
const CLOSER = String.raw`(?:\[\.\)\]|\[\)\.\]|\\\.|\\\)|\\\]|\(\?:\\\.)`;

const LABEL_OPENING = new RegExp(`${OPENING}${NUMBER}${CLOSER}`, "u");

export const readsParagraphLabel = (pattern: string): boolean =>
  LABEL_OPENING.test(pattern);

const regexPattern = (node: unknown): string | null => {
  if (
    !isAstNode(node) ||
    typeof node.regex !== "object" ||
    node.regex === null ||
    !("pattern" in node.regex)
  ) {
    return null;
  }
  const { pattern } = node.regex;
  return typeof pattern === "string" ? pattern : null;
};

const isRegExpCallee = (node: unknown): boolean =>
  isAstNode(node) && node.type === "Identifier" && node.name === "RegExp";

export default eslintCompatPlugin({
  meta: { name: "no-local-paragraph-label" },
  rules: {
    "no-local-paragraph-label": {
      meta: {
        type: "problem",
        messages: {
          owner:
            "Read printed paragraph labels through readPrintedLabel() or printedLabelOpensParagraph() from @stll/legal-ast/printed-paragraph-labels, so one grammar decides where a label opens a paragraph.",
        },
      },
      createOnce(context) {
        const check = (node: unknown, pattern: string | null) => {
          if (
            pattern !== null &&
            readsParagraphLabel(pattern) &&
            isAstNode(node)
          ) {
            context.report({ node, messageId: "owner" });
          }
        };
        const checkConstruction = (node: unknown) => {
          if (!isAstNode(node) || !isRegExpCallee(node.callee)) {
            return;
          }
          const [source] = Array.isArray(node.arguments) ? node.arguments : [];
          if (
            isAstNode(source) &&
            source.type === "Literal" &&
            typeof source.value === "string"
          ) {
            check(node, source.value);
          }
        };
        return {
          Literal(node) {
            check(node, regexPattern(node));
          },
          NewExpression: checkConstruction,
          CallExpression: checkConstruction,
        };
      },
    },
  },
});
