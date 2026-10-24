// A heading is one typographic statement. Styling a fragment differently is
// allowed only when the fragment has an independently expressed meaning or is
// part of a link. The narrow meaning allowlist is `lang`, `aria-label`, and
// `aria-labelledby`: each changes how the fragment is understood or announced.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  classBaseName,
  classTokens,
  elementName,
  getPropertyName,
  isAstNode,
  jsxName,
  staticStringValue,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const ACCENT_ELEMENTS = new Set(["span", "em", "strong", "mark", "i", "b"]);
const STYLE_ATTRIBUTES = new Set(["class", "className", "style"]);
const MEANING_ATTRIBUTES = new Set(["lang", "aria-label", "aria-labelledby"]);
const LAYOUT_CLASSES = new Set([
  "truncate",
  "text-ellipsis",
  "overflow-hidden",
  "whitespace-nowrap",
  "min-w-0",
  "shrink-0",
  "flex-1",
  "grow",
]);
const COUNTER_CLASSES = new Set([
  ...LAYOUT_CLASSES,
  "tabular-nums",
  "text-muted-foreground",
  "text-foreground-ghost",
  "font-normal",
  "ms-2",
]);

type CounterPart = "number" | "separator" | "other";

const counterPart = (node: unknown): CounterPart => {
  if (!isAstNode(node)) {
    return "other";
  }
  if (node.type === "JSXEmptyExpression") {
    return "separator";
  }
  if (node.type === "JSXExpressionContainer") {
    return counterPart(node.expression);
  }
  if (node.type === "Literal" && typeof node.value === "number") {
    return "number";
  }
  if (node.type === "JSXText" || node.type === "Literal") {
    if (
      typeof node.value !== "string" ||
      !/^[\p{N}\p{P}\p{Z}\s%+−]*$/u.test(node.value)
    ) {
      return "other";
    }
    return /\p{N}/u.test(node.value) ? "number" : "separator";
  }
  // The shared locale formatter renders numeric values through `.number()`.
  const callee = node.type === "CallExpression" ? node.callee : null;
  return isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    getPropertyName(callee.property) === "number"
    ? "number"
    : "other";
};

const hasNumericContent = (node: AstNode): boolean => {
  if (!Array.isArray(node.children)) {
    return false;
  }
  const parts = node.children.map(counterPart);
  return parts.includes("number") && !parts.includes("other");
};

// Numeric counters retain their stable digits and secondary treatment;
// layout-only utilities do not give heading words a decorative accent.
const hasDecorativeStyle = (node: AstNode): boolean =>
  attributesOf(node).some((attribute) => {
    const name = jsxName(attribute.name);
    if (name === null || !STYLE_ATTRIBUTES.has(name)) {
      return false;
    }
    if (name === "style") {
      return true;
    }
    const value =
      isAstNode(attribute.value) &&
      attribute.value.type === "JSXExpressionContainer"
        ? attribute.value.expression
        : attribute.value;
    const classes = staticStringValue(value);
    if (classes === null) {
      return true;
    }
    const tokens = classTokens(classes).map(classBaseName);
    return (
      !tokens.every((token) => LAYOUT_CLASSES.has(token)) &&
      !(
        tokens.includes("tabular-nums") &&
        hasNumericContent(node) &&
        tokens.every((token) => COUNTER_CLASSES.has(token))
      )
    );
  });

const attributesOf = (node: unknown): AstNode[] => {
  if (!isAstNode(node) || node.type !== "JSXElement") {
    return [];
  }
  const opening = node.openingElement;
  if (!isAstNode(opening) || !Array.isArray(opening.attributes)) {
    return [];
  }
  return opening.attributes.filter(
    (attribute): attribute is AstNode =>
      isAstNode(attribute) && attribute.type === "JSXAttribute",
  );
};

const hasAttribute = (node: unknown, names: ReadonlySet<string>): boolean =>
  attributesOf(node).some((attribute) => {
    const name = jsxName(attribute.name);
    return name !== null && names.has(name);
  });

const isHeading = (node: unknown): boolean => {
  const name = elementName(node);
  return name !== null && (/^h[1-4]$/u.test(name) || name.endsWith("Heading"));
};

const enclosingHeadingUnlessLinked = (node: AstNode): AstNode | null => {
  let ancestor = node.parent;
  while (isAstNode(ancestor)) {
    if (ancestor.type === "JSXElement") {
      if (elementName(ancestor) === "a") {
        return null;
      }
      if (isHeading(ancestor)) {
        return ancestor;
      }
    }
    ancestor = ancestor.parent;
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-decorative-heading-accent" },
  rules: {
    "no-decorative-heading-accent": {
      meta: {
        type: "problem",
        messages: {
          decorativeAccent:
            "Keep headings to one typographic treatment. Remove this fragment's class/style, or use a link or a documented meaning attribute when the distinction communicates meaning.",
        },
      },
      createOnce(context) {
        return {
          JSXElement(node) {
            if (!isAstNode(node)) {
              return;
            }
            const name = elementName(node);
            if (
              name === null ||
              !ACCENT_ELEMENTS.has(name) ||
              !hasDecorativeStyle(node) ||
              hasAttribute(node, MEANING_ATTRIBUTES) ||
              enclosingHeadingUnlessLinked(node) === null
            ) {
              return;
            }
            context.report({ node, messageId: "decorativeAccent" });
          },
        };
      },
    },
  },
});
