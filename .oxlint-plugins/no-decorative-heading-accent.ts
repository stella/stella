// A heading is one typographic statement. Styling a fragment differently is
// allowed only when the fragment has an independently expressed meaning or is
// part of a link. The narrow meaning allowlist is `lang`, `aria-label`, and
// `aria-labelledby`: each changes how the fragment is understood or announced.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  classBaseName,
  classTokens,
  elementName,
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

// Numeric counters retain their stable digits and secondary treatment;
// layout-only utilities do not give heading words a decorative accent.
const hasDecorativeStyle = (node: AstNode): boolean =>
  attributesOf(node).some((attribute) => {
    const name = jsxName(attribute.name);
    if (name === null || !STYLE_ATTRIBUTES.has(name)) return false;
    if (name === "style") return true;
    const value =
      isAstNode(attribute.value) &&
      attribute.value.type === "JSXExpressionContainer"
        ? attribute.value.expression
        : attribute.value;
    const classes = staticStringValue(value);
    if (classes === null) return true;
    const tokens = classTokens(classes).map(classBaseName);
    return (
      !tokens.every((token) => LAYOUT_CLASSES.has(token)) &&
      !(
        tokens.includes("tabular-nums") &&
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
  return name !== null && (/^h[1-4]$/u.test(name) || /Heading$/u.test(name));
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
