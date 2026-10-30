// Copy that users or agents read never contains an em dash: a period, comma,
// colon or parentheses carries the same break and reads the same in every
// locale. Translation catalogues are JSON, which oxlint does not parse;
// `packages/scripts/src/i18n-lint.ts` and the desktop catalogue test hold them
// to the same rule.
//
// Only the glyph written into the source is flagged. Code that processes the
// character (a normalizer, a parser of court text) spells it as the `\u2014`
// escape or in a regular expression, which states that it is data, not copy.
// Comments are not copy and are never checked. A value that is only the glyph
// is the empty-cell marker tables render for a missing value, not punctuation,
// and stays allowed.
//
// Flagged:
//   const label = "Saved — just now";
//   <p>Draft — not sent</p>
//   <p>Draft &mdash; not sent</p>
//   `${count} items — ${size}`
// Allowed:
//   const DASHES = ["\u2014", "\u2013"];
//   text.replace(/—/gu, "-")
//   "2019–2024"                      (en dash range)
//   invoice.dueDate ?? "—"           (empty-cell marker)
// Flagged too, as a separator rather than a marker:
//   {" — "}   parts.join(" — ")

import { eslintCompatPlugin } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import { filenameForContext } from "./utils.ts";

const EM_DASH = "\u2014";
const EM_DASH_ENTITY = /&(?:mdash|#8212|#x0*2014);/iu;

// A string value must be exactly the glyph: `" — "` with spaces is a separator
// between two pieces of copy, not a missing value. JSX text may carry the
// surrounding layout whitespace.
const EMPTY_CELL_MARKER = /^(?:\u2014|&mdash;|&#8212;|&#x0*2014;)$/iu;
const EMPTY_CELL_TEXT = /^\s*(?:\u2014|&mdash;|&#8212;|&#x0*2014;)\s*$/iu;

const containsEmDash = (raw: string | null | undefined): boolean =>
  raw !== null && raw !== undefined && raw.includes(EM_DASH);

// The raw text between the quotes, so a lone marker is recognised whatever
// quote character wraps it.
const unquoted = (raw: string): string => raw.slice(1, -1);

export default eslintCompatPlugin({
  meta: { name: "no-em-dash-copy" },
  rules: {
    "no-em-dash-copy": {
      meta: {
        type: "problem",
        messages: {
          emDash:
            "Copy must not contain an em dash. Rewrite the break with a " +
            "period, comma, colon or parentheses. Code that handles the " +
            "character as data spells it as the `\\u2014` escape.",
        },
      },
      createOnce(context) {
        const enforces = (node: { range: readonly [number, number] }) => {
          const start = context.sourceCode.getLocFromIndex(node.range[0]).line;
          const end = context.sourceCode.getLocFromIndex(
            node.range[1] - 1,
          ).line;
          for (let line = start; line <= end; line++) {
            if (
              guardEnforcesLine({
                guard: "no-em-dash-copy",
                file: filenameForContext(context),
                line,
              })
            ) {
              return true;
            }
          }
          return false;
        };
        return {
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            // JSX attribute strings decode HTML entities like JSX text does.
            const decodesEntities = node.parent.type === "JSXAttribute";
            const raw = node.raw ?? "";
            if (EMPTY_CELL_MARKER.test(unquoted(raw))) {
              return;
            }
            if (
              (containsEmDash(raw) ||
                (decodesEntities && EM_DASH_ENTITY.test(raw))) &&
              enforces(node)
            ) {
              context.report({ node, messageId: "emDash" });
            }
          },
          TemplateElement(node) {
            const { raw } = node.value;
            if (EMPTY_CELL_MARKER.test(raw)) {
              return;
            }
            if (containsEmDash(raw) && enforces(node)) {
              context.report({ node, messageId: "emDash" });
            }
          },
          JSXText(node) {
            const raw = node.raw ?? node.value;
            if (EMPTY_CELL_TEXT.test(raw)) {
              return;
            }
            if (
              (containsEmDash(raw) || EM_DASH_ENTITY.test(raw)) &&
              enforces(node)
            ) {
              context.report({ node, messageId: "emDash" });
            }
          },
        };
      },
    },
  },
});
