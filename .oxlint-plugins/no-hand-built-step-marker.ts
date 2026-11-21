import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";

import {
  elementName,
  getPropertyName,
  isAstNode,
  isIdentifier,
} from "./utils.ts";

const PADDED_MARKER = /^0[1-9]$/u;
const INDEX_NAMES = new Set(["i", "index", "positionIndex", "stepIndex"]);

const isInsideSteps = (node: Ranged): boolean => {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (current.type === "JSXElement") {
      const name = elementName(current);
      if (name === "Steps") {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
};

const containsIndexIncrement = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (
    node.type === "BinaryExpression" &&
    node.operator === "+" &&
    isIdentifier(node.left) &&
    INDEX_NAMES.has(node.left.name) &&
    isAstNode(node.right) &&
    node.right.type === "Literal" &&
    node.right.value === 1
  ) {
    return true;
  }
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some(containsIndexIncrement)
        : containsIndexIncrement(value)),
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-hand-built-step-marker" },
  rules: {
    "no-hand-built-step-marker": {
      meta: {
        type: "problem",
        messages: {
          marker:
            "Do not hand-build a numbered marker. Remove decorative numbering or render a meaningful sequence through Steps.",
        },
      },
      createOnce(context) {
        const reported = new WeakSet<Ranged>();
        const report = (node: Ranged) => {
          if (!isInsideSteps(node) && !reported.has(node)) {
            reported.add(node);
            context.report({ node, messageId: "marker" });
          }
        };
        return {
          JSXText(node) {
            if (PADDED_MARKER.test(node.value.trim())) {
              report(node);
            }
          },
          CallExpression(node) {
            if (
              isAstNode(node.callee) &&
              node.callee.type === "MemberExpression" &&
              getPropertyName(node.callee.property) === "padStart" &&
              containsIndexIncrement(node.callee.object)
            ) {
              let current: unknown = node.parent;
              while (
                isAstNode(current) &&
                (current.type === "CallExpression" ||
                  current.type === "MemberExpression")
              ) {
                current = current.parent;
              }
              if (
                isAstNode(current) &&
                current.type === "JSXExpressionContainer"
              ) {
                report(current);
              }
            }
          },
          JSXExpressionContainer(node) {
            if (!containsIndexIncrement(node.expression)) {
              return;
            }
            const parent = node.parent;
            if (!isAstNode(parent) || parent.type !== "JSXElement") {
              return;
            }
            const position = parent.children.indexOf(node);
            const next = parent.children[position + 1];
            if (
              isAstNode(next) &&
              next.type === "JSXText" &&
              /^\s*\./u.test(next.value)
            ) {
              report(node);
            }
          },
        };
      },
    },
  },
});
