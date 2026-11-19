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

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import { regexSourceVisitors } from "./regex-sources.ts";
import { filenameForContext } from "./utils.ts";

/** A line start, perhaps after spaces, a group and an opening bracket. */
const OPENING = String.raw`^\^(?:\\s[*+?]?|\[[^\]]*\][*+?]?)?(?:\\\(\??|\\\[)?(?:\(\?:|\((?:\?<\w+>)?)?(?:\\\(\??|\\\[)?`;
/** A run of digits: `\d{1,3}`, `\d{2}`, `\d+`, `[0-9]{1,2}`. */
const NUMBER = String.raw`(?:\\d|\[0-9\])(?:\{\d(?:,\d)?\}|\+)\)?`;
/** What closes a label: a dot, a parenthesis, a bracket, a sub-number's dot. */
const CLOSER = String.raw`(?:\[[.):]{2,3}\]|\\\.|\\\)|\\\]|\(\?:\\\.)`;

const LABEL_OPENING = new RegExp(`${OPENING}${NUMBER}${CLOSER}`, "u");

export const readsParagraphLabel = (pattern: string): boolean =>
  LABEL_OPENING.test(pattern);

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
        return regexSourceVisitors((node, pattern) => {
          if (
            readsParagraphLabel(pattern) &&
            guardEnforcesLine({
              guard: "no-local-paragraph-label",
              file: filenameForContext(context),
              line: context.sourceCode.getLocFromIndex(node.range[0]).line,
            })
          ) {
            context.report({ node, messageId: "owner" });
          }
        });
      },
    },
  },
});
