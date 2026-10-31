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
  filenameForContext,
  isAstNode,
  isIdentifier,
  jsxName,
  staticStringValue,
} from "./utils.ts";

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

const stringContainsNormalWhitespace = (value: string): boolean =>
  classTokens(value).some(
    (token) => classBaseName(token).replaceAll("!", "") === "whitespace-normal",
  );

const containsNormalWhitespace = (className: unknown): boolean => {
  const value = staticStringValue(className);
  if (value !== null) {
    return stringContainsNormalWhitespace(value);
  }
  if (!isAstNode(className)) {
    return false;
  }
  if (className.type === "ConditionalExpression") {
    return (
      containsNormalWhitespace(className.consequent) ||
      containsNormalWhitespace(className.alternate)
    );
  }
  if (className.type === "TemplateLiteral") {
    const quasis = Array.isArray(className.quasis) ? className.quasis : [];
    const expressions = Array.isArray(className.expressions)
      ? className.expressions
      : [];
    return [...quasis, ...expressions].some((part) => {
      if (!isAstNode(part)) {
        return false;
      }
      const templateValue = templateElementString(part);
      return templateValue === null
        ? containsNormalWhitespace(part)
        : stringContainsNormalWhitespace(templateValue);
    });
  }
  if (
    className.type !== "CallExpression" ||
    (!isIdentifier(className.callee, "cn") &&
      !isIdentifier(className.callee, "clsx")) ||
    !Array.isArray(className.arguments)
  ) {
    return false;
  }
  return className.arguments.some((argument) => {
    const argumentValue = staticStringValue(argument);
    return (
      argumentValue !== null && stringContainsNormalWhitespace(argumentValue)
    );
  });
};

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
          JSXOpeningElement(node) {
            if (
              !isAstNode(node) ||
              !isAstNode(node.name) ||
              node.name.type !== "JSXIdentifier" ||
              node.name.name !== "Button"
            ) {
              return;
            }
            const className = getClassNameAttribute(node);
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
