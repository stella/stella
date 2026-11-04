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
// Flagged too, as a separator rather than a marker, including through a name:
//   {" — "}   parts.join(" — ")
//   const separator = "—"; parts.join(separator)

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  filenameForContext,
  getCalleeName,
  memberPropertyName,
  type ScopeContext,
  TRANSPARENT_WRAPPERS,
} from "./utils.ts";

const EM_DASH = "\u2014";
const EM_DASH_ENTITY = /&(?:mdash|#0*8212|#x0*2014);/iu;
const EM_DASH_MARK = /\u2014|&(?:mdash|#0*8212|#x0*2014);/giu;

const EMPTY_CELL_MARKER = /^(?:\u2014|&mdash;|&#0*8212;|&#x0*2014;)$/iu;

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

// A marker bound to a name is still copy when a use composes it with other
// text: `parts.join(separator)`, `left + separator` or `${separator}`.
const isComposingUse = (reference: ESTree.Node): boolean => {
  let use: ESTree.Node = reference;
  while (use.parent !== null && TRANSPARENT_WRAPPERS.has(use.parent.type)) {
    use = use.parent;
  }
  const { parent } = use;
  if (parent === null) {
    return false;
  }
  if (parent.type === "TemplateLiteral" || parent.type === "BinaryExpression") {
    return true;
  }
  return (
    parent.type === "CallExpression" &&
    parent.arguments.some((argument) => argument === use) &&
    parent.callee.type === "MemberExpression" &&
    memberPropertyName(parent.callee) === "join"
  );
};

// The binding a declarator introduces, found from the declarator's scope.
const declaredVariable = (
  context: ScopeContext,
  declarator: ESTree.VariableDeclarator,
  name: string,
) => {
  let scope: ReturnType<ScopeContext["sourceCode"]["getScope"]> | null =
    context.sourceCode.getScope(declarator);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

const bindingComposesMarker = (
  context: ScopeContext,
  declarator: ESTree.VariableDeclarator,
): boolean => {
  if (declarator.id.type !== "Identifier") {
    return false;
  }
  const variable = declaredVariable(context, declarator, declarator.id.name);
  return (
    variable?.references.some(
      (reference) =>
        reference.identifier !== declarator.id &&
        isComposingUse(reference.identifier),
    ) === true
  );
};

const isSoleMarkerContent = (
  node: ESTree.Node,
  context: ScopeContext,
): boolean => {
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
      // alone; any other parent composes it with more content. A binding is
      // followed to its uses, since one of them may compose it.
      if (parent.type === "VariableDeclarator") {
        return !bindingComposesMarker(context, parent);
      }
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

// `console.warn(...)` and `console["warn"](...)` name the same method.
const isConsoleCallee = (callee: ESTree.Node): boolean => {
  if (
    callee.type === "MemberExpression" &&
    callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "console" &&
    callee.property.type === "Literal" &&
    typeof callee.property.value === "string"
  ) {
    return CONSOLE_METHOD.test(`console.${callee.property.value}`);
  }
  return CONSOLE_METHOD.test(getCalleeName(callee) ?? "");
};

// Parts that only build the argument a call receives: a template around the
// text or a concatenation with it. Any other parent hands the text to code
// that may show it.
const ARGUMENT_PARTS: ReadonlySet<string> = new Set([
  "TemplateLiteral",
  "BinaryExpression",
]);

// Text passed to `console.*` is a diagnostic for developers, not copy. Only
// text the console call itself receives is exempt: a literal handed to
// another call first (`console.log(showToast("..."))`) is still copy.
const isConsoleArgument = (node: ESTree.Node): boolean => {
  let current: ESTree.Node = node;
  while (current.parent !== null) {
    const child = current;
    const { parent } = child;
    if (FUNCTION_BOUNDARIES.has(parent.type)) {
      return false;
    }
    if (parent.type === "CallExpression") {
      return (
        parent.arguments.some((argument) => argument === child) &&
        isConsoleCallee(parent.callee)
      );
    }
    if (
      !ARGUMENT_PARTS.has(parent.type) &&
      !TRANSPARENT_WRAPPERS.has(parent.type)
    ) {
      return false;
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
        // During the changed-lines rollout a dash counts on its own line, so
        // editing another line of a multiline string does not report it.
        const enforces = (node: { range: readonly [number, number] }) => {
          const text = context.sourceCode.text.slice(
            node.range[0],
            node.range[1],
          );
          return [...text.matchAll(EM_DASH_MARK)].some((match) =>
            guardEnforcesLine({
              guard: "no-em-dash-copy",
              file: filenameForContext(context),
              line: context.sourceCode.getLocFromIndex(
                node.range[0] + match.index,
              ).line,
            }),
          );
        };
        return {
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            // JSX attribute strings decode HTML entities like JSX text does.
            const decodesEntities = node.parent.type === "JSXAttribute";
            const raw = node.raw ?? "";
            if (isSoleMarkerContent(node, context) || isConsoleArgument(node)) {
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
            if (isSoleMarkerContent(node, context) || isConsoleArgument(node)) {
              return;
            }
            if (containsEmDash(raw) && enforces(node)) {
              context.report({ node, messageId: "emDash" });
            }
          },
          JSXText(node) {
            const raw = node.raw ?? node.value;
            if (isSoleMarkerContent(node, context) || isConsoleArgument(node)) {
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
