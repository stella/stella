// A Button's fixed size height can make wrapped text overlap the next row.
//
// Flag `whitespace-normal` in strings inside a Button's `className` attribute,
// including class helpers and interpolated template chunks. The analysis is
// syntactic: it does not resolve imported class constants or component aliases.
// Use the Button's `layout="wrap"` API, which owns the required row sizing.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  classBaseName,
  classTokens,
  everyNode,
  filenameForContext,
  isAstNode,
  jsxName,
  staticStringValue,
} from "./utils.ts";

const getOpeningElement = (element: unknown): AstNode | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};

const getClassNameAttribute = (openingElement: unknown): AstNode | null => {
  if (!isAstNode(openingElement) || !Array.isArray(openingElement.attributes)) {
    return null;
  }
  return (
    openingElement.attributes.find(
      (attribute): attribute is AstNode =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        jsxName(attribute.name) === "className",
    ) ?? null
  );
};

const classNameValue = (attribute: AstNode): unknown => {
  const value = attribute.value;
  if (!isAstNode(value) || value.type !== "JSXExpressionContainer") {
    return value;
  }
  return value.expression;
};

const templateElementString = (node: AstNode): string | null => {
  if (node.type !== "TemplateElement") {
    return null;
  }
  const value = node.value;
  if (
    typeof value !== "object" ||
    value === null ||
    !("cooked" in value) ||
    !("raw" in value)
  ) {
    return null;
  }
  if (typeof value.cooked === "string") {
    return value.cooked;
  }
  return typeof value.raw === "string" ? value.raw : null;
};

const containsNormalWhitespace = (className: unknown): boolean =>
  everyNode(className).some((node) => {
    const value = staticStringValue(node) ?? templateElementString(node);
    if (value === null) {
      return false;
    }
    return classTokens(value).some(
      (token) =>
        classBaseName(token).replaceAll("!", "") === "whitespace-normal",
    );
  });

export default eslintCompatPlugin({
  meta: { name: "no-button-whitespace-normal" },
  rules: {
    "no-button-whitespace-normal": {
      meta: {
        type: "problem",
        messages: {
          wrappingButton:
            'Use Button layout="wrap"; fixed size heights let wrapped text overlap following rows.',
        },
      },
      createOnce(context) {
        return {
          before() {
            return filenameForContext(context).endsWith(".tsx");
          },
          JSXElement(node) {
            const openingElement = getOpeningElement(node);
            if (jsxName(openingElement?.name) !== "Button") {
              return;
            }
            const className = getClassNameAttribute(openingElement);
            if (
              className === null ||
              !containsNormalWhitespace(classNameValue(className))
            ) {
              return;
            }
            context.report({ node: className, messageId: "wrappingButton" });
          },
        };
      },
    },
  },
});
