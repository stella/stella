// A heading is one typographic statement. Styling a fragment differently is
// allowed only when the fragment has an independently expressed meaning or is
// part of a link. The narrow meaning allowlist is `lang`, `aria-label`, and
// `aria-labelledby`: each changes how the fragment is understood or announced.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { elementName, isAstNode, jsxName } from "./utils.ts";
import type { AstNode } from "./utils.ts";

const ACCENT_ELEMENTS = new Set(["span", "em", "strong", "mark", "i", "b"]);
const STYLE_ATTRIBUTES = new Set(["class", "className", "style"]);
const MEANING_ATTRIBUTES = new Set(["lang", "aria-label", "aria-labelledby"]);

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
      create(context) {
        return {
          JSXElement(node) {
            const name = elementName(node);
            if (
              name === null ||
              !ACCENT_ELEMENTS.has(name) ||
              !hasAttribute(node, STYLE_ATTRIBUTES) ||
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
