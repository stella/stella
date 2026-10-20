// Page-level narrative paragraphs must use the shared Prose component so their
// line measure stays readable. This syntactic rule is intentionally enrolled
// only for page templates, never reusable component internals. Task-shaped
// content is narrowly exempt: paragraphs with a role, compact text-xs labels,
// display labels, and descendants of forms, tables, editors, code, or pre.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { elementName, isAstNode } from "./utils.ts";

const TASK_ANCESTORS = new Set(["code", "form", "pre", "table"]);

const attributeName = (attribute: unknown): string | null => {
  if (!isAstNode(attribute) || attribute.type !== "JSXAttribute") {
    return null;
  }
  const name = attribute.name;
  return isAstNode(name) &&
    name.type === "JSXIdentifier" &&
    typeof name.name === "string"
    ? name.name
    : null;
};

const literalAttribute = (node: unknown, name: string): string | null => {
  if (!isAstNode(node) || node.type !== "JSXElement") {
    return null;
  }
  const opening = node.openingElement;
  if (!isAstNode(opening) || !Array.isArray(opening.attributes)) {
    return null;
  }
  const attribute = opening.attributes.find(
    (candidate) => attributeName(candidate) === name,
  );
  if (!isAstNode(attribute) || !isAstNode(attribute.value)) {
    return null;
  }
  return attribute.value.type === "Literal" &&
    typeof attribute.value.value === "string"
    ? attribute.value.value
    : null;
};

const hasAttribute = (node: unknown, name: string): boolean => {
  if (!isAstNode(node) || node.type !== "JSXElement") {
    return false;
  }
  const opening = node.openingElement;
  return (
    isAstNode(opening) &&
    Array.isArray(opening.attributes) &&
    opening.attributes.some((attribute) => attributeName(attribute) === name)
  );
};

const isTaskShaped = (node: unknown): boolean => {
  if (hasAttribute(node, "role")) {
    return true;
  }
  const classes =
    literalAttribute(node, "className") ??
    literalAttribute(node, "class") ??
    "";
  if (
    classes
      .split(/\s+/u)
      .some((token) => token === "text-xs" || token === "font-display")
  ) {
    return true;
  }
  let current = isAstNode(node) ? node.parent : null;
  while (isAstNode(current)) {
    if (current.type === "JSXElement") {
      const name = elementName(current);
      if (
        name !== null &&
        (TASK_ANCESTORS.has(name) || name.endsWith("Editor"))
      ) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "narrative-prose-component" },
  rules: {
    "require-prose": {
      meta: {
        type: "problem",
        messages: {
          requireProse:
            "Render page-level narrative text with Prose to keep its line measure below 80 characters.",
        },
      },
      createOnce(context) {
        return {
          JSXElement(node) {
            if (elementName(node) === "p" && !isTaskShaped(node)) {
              context.report({ node, messageId: "requireProse" });
            }
          },
        };
      },
    },
  },
});
