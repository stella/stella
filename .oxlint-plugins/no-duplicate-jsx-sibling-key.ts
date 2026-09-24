// React keys identify one child among its siblings. Reusing the same explicit
// key for two direct JSX children makes reconciliation ambiguous: a refresh,
// navigation, or conditional update can preserve, duplicate, or remove the
// wrong subtree.
//
// `react/jsx-key` requires keys for array-produced children and can detect
// duplicates in those arrays. It does not compare explicitly keyed static JSX
// siblings, which is the shape this rule owns.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { SourceCode } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { isAstNode, unwrapExpression } from "./utils.ts";

const jsxAttributeName = (node: unknown): string | null =>
  isAstNode(node) &&
  node.type === "JSXIdentifier" &&
  typeof node.name === "string"
    ? node.name
    : null;

const openingElementOf = (node: unknown): AstNode | null =>
  isAstNode(node) &&
  node.type === "JSXElement" &&
  isAstNode(node.openingElement)
    ? node.openingElement
    : null;

const keyAttributeOf = (node: unknown): AstNode | null => {
  const openingElement = openingElementOf(node);
  if (openingElement === null || !Array.isArray(openingElement.attributes)) {
    return null;
  }
  return (
    openingElement.attributes.find(
      (attribute): attribute is AstNode =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        jsxAttributeName(attribute.name) === "key",
    ) ?? null
  );
};

const keySignature = (
  attribute: AstNode,
  sourceCode: SourceCode,
): string | null => {
  const value = attribute.value;
  if (!isAstNode(value)) {
    return "implicit:true";
  }
  if (value.type === "Literal") {
    return `literal:${JSON.stringify(value.value)}`;
  }
  if (value.type !== "JSXExpressionContainer") {
    return `jsx:${sourceCode.getText(value)}`;
  }
  const expression = unwrapExpression(value.expression);
  if (expression === null || expression.type === "JSXEmptyExpression") {
    return null;
  }
  if (expression.type === "Literal") {
    return `literal:${JSON.stringify(expression.value)}`;
  }
  return `expression:${sourceCode.getText(expression)}`;
};

const checkChildren = (node, context) => {
  if (!Array.isArray(node.children)) {
    return;
  }
  const seenSignatures = new Set<string>();
  for (const child of node.children) {
    const attribute = keyAttributeOf(child);
    if (attribute === null) {
      continue;
    }
    const signature = keySignature(attribute, context.sourceCode);
    if (signature === null) {
      continue;
    }
    if (seenSignatures.has(signature)) {
      context.report({ node: attribute, messageId: "duplicateSiblingKey" });
      continue;
    }
    seenSignatures.add(signature);
  }
};

export default eslintCompatPlugin({
  meta: { name: "no-duplicate-jsx-sibling-key" },
  rules: {
    "no-duplicate-jsx-sibling-key": {
      meta: {
        type: "problem",
        messages: {
          duplicateSiblingKey:
            "Direct JSX siblings must not share a key; give each child a distinct identity or remove unnecessary static keys.",
        },
      },
      createOnce(context) {
        return {
          JSXElement(node) {
            checkChildren(node, context);
          },
          JSXFragment(node) {
            checkChildren(node, context);
          },
        };
      },
    },
  },
});
