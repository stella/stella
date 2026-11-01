// Copy that users or agents read never contains an em dash: a period, comma,
// colon or parentheses carries the same break and reads the same in every
// locale. Translation catalogues are JSON, which oxlint does not parse;
// `packages/scripts/src/i18n-lint.ts` and the desktop catalogue test hold them
// to the same rule.
//
// Only the glyph written into the source is flagged. Code that processes the
// character (a normalizer, a parser of court text) spells it as the `\u2014`
// escape or in a regular expression, which states that it is data, not copy.
// Comments and console arguments are diagnostics, not copy, and are never
// checked. A value that is only the glyph
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

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  filenameForContext,
  getCalleeName,
  TRANSPARENT_WRAPPERS,
} from "./utils.ts";

const EM_DASH = "\u2014";
const EM_DASH_ENTITY = /&(?:mdash|#8212|#x0*2014);/iu;

const EMPTY_CELL_MARKER = /^(?:\u2014|&mdash;|&#8212;|&#x0*2014;)$/iu;

const containsEmDash = (raw: string | null | undefined): boolean =>
  raw?.includes(EM_DASH) === true;

// Follow the complete value to its owner: a marker segment is not a marker
// value when a template, concatenation or rendered sibling adds content.
const markerText = (node: ESTree.Node): string | null => {
  if (node.type === "Literal") {
    return (node.raw ?? "").slice(1, -1);
  }
  if (node.type === "TemplateElement") {
    return node.value.raw;
  }
  if (node.type === "JSXText") {
    return (node.raw ?? node.value).trim();
  }
  return null;
};

const SOLE_CONTENT_ENDS: ReadonlySet<string> = new Set([
  "VariableDeclarator",
  "ReturnStatement",
  "ArrowFunctionExpression",
  "Property",
  "PropertyDefinition",
  "AssignmentPattern",
  "JSXAttribute",
  "ExpressionStatement",
  "ExportDefaultDeclaration",
]);

const isSoleMarkerContent = (node: ESTree.Node): boolean => {
  const raw = markerText(node);
  if (raw === null || !EMPTY_CELL_MARKER.test(raw)) {
    return false;
  }
  let content: ESTree.Node = node;
  while (content.parent !== null) {
    const current = content;
    const parent = content.parent;
    if (TRANSPARENT_WRAPPERS.has(parent.type)) {
      content = parent;
      continue;
    }
    if (parent.type === "TemplateLiteral") {
      if (parent.expressions.length !== 0) {
        return false;
      }
    } else if (parent.type === "JSXElement" || parent.type === "JSXFragment") {
      if (
        !parent.children.every(
          (child) =>
            child === current ||
            (child.type === "JSXText" && child.value.trim() === "") ||
            (child.type === "JSXExpressionContainer" &&
              child.expression.type === "JSXEmptyExpression"),
        )
      ) {
        return false;
      }
      if (parent.type === "JSXElement") {
        return true;
      }
    } else if (parent.type === "ConditionalExpression") {
      if (parent.test === content) {
        return false;
      }
    } else if (parent.type === "LogicalExpression") {
      if (parent.operator === "&&" && parent.left === content) {
        return false;
      }
    } else if (parent.type === "SequenceExpression") {
      if (parent.expressions.at(-1) !== content) {
        return false;
      }
    } else if (parent.type !== "JSXExpressionContainer") {
      // A binding, return, property, attribute or statement holds the marker
      // alone; any other parent composes it with more content.
      return SOLE_CONTENT_ENDS.has(parent.type);
    }
    content = parent;
  }
  return true;
};

const CONSOLE_METHOD = /^console\.[a-z]+$/u;
const FUNCTION_BOUNDARIES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

// Text passed to `console.*` is a diagnostic for developers, not copy.
const isConsoleArgument = (node: ESTree.Node): boolean => {
  let current: ESTree.Node = node;
  while (current.parent !== null) {
    const child = current;
    const { parent } = child;
    if (FUNCTION_BOUNDARIES.has(parent.type)) {
      return false;
    }
    if (
      parent.type === "CallExpression" &&
      parent.arguments.some((argument) => argument === child) &&
      CONSOLE_METHOD.test(getCalleeName(parent.callee) ?? "")
    ) {
      return true;
    }
    current = parent;
  }
  return false;
};

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
            if (isSoleMarkerContent(node) || isConsoleArgument(node)) {
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
            if (isSoleMarkerContent(node) || isConsoleArgument(node)) {
              return;
            }
            if (containsEmDash(raw) && enforces(node)) {
              context.report({ node, messageId: "emDash" });
            }
          },
          JSXText(node) {
            const raw = node.raw ?? node.value;
            if (isSoleMarkerContent(node) || isConsoleArgument(node)) {
              return;
            }
            if (
              (containsEmDash(raw) || EM_DASH_ENTITY.test(raw)) &&
              enforces(node)
            ) {
              // JSX text starts after the previous tag or expression, often a
              // line above the copy: point at the dash itself.
              const offsets = [
                raw.indexOf(EM_DASH),
                raw.search(EM_DASH_ENTITY),
              ];
              const first = Math.min(
                ...offsets.filter((offset) => offset >= 0),
              );
              const { line, column } = context.sourceCode.getLocFromIndex(
                node.range[0] + (Number.isFinite(first) ? first : 0),
              );
              context.report({ loc: { line, column }, messageId: "emDash" });
            }
          },
        };
      },
    },
  },
});
