import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, jsxName, staticStringValue } from "./utils.ts";

export const PLACEHOLDER_STELLA_MARK_MESSAGE =
  "A letter or section sign is not the stella symbol. Render `StellaMark` " +
  "from '@stll/ui/stella-mark', or use the official " +
  "apps/landing/public/brand/stella-symbol.svg asset in static markup.";

export const isPlaceholderStellaMark = (value: string) =>
  /^(?:s|§|&sect;|&#0*167;|&#x0*a7;)$/iu.test(value.trim());

export const isStellaBrandIdentifier = (value: string) =>
  /(?:^|[^a-z0-9])(?:mark|logo|brand|app[\s_-]*icon)(?:$|[^a-z0-9])/iu.test(
    value.replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2"),
  );

const attributeNamesBrand = (attribute: unknown) => {
  if (!isAstNode(attribute) || attribute.type !== "JSXAttribute") {
    return false;
  }
  const name = jsxName(attribute.name);
  if (name === null) {
    return false;
  }
  if (name.startsWith("data-") && isStellaBrandIdentifier(name)) {
    return true;
  }
  if (
    name !== "className" &&
    name !== "class" &&
    name !== "aria-label" &&
    !name.startsWith("data-")
  ) {
    return false;
  }
  const { value } = attribute;
  const text =
    isAstNode(value) && value.type === "JSXExpressionContainer"
      ? staticStringValue(value.expression)
      : staticStringValue(value);
  return text !== null && isStellaBrandIdentifier(text);
};

// Comments and whitespace contribute no rendered content; any dynamic child
// or nested element makes this more than a lone placeholder text node.
const onlyStaticChildText = (children: readonly unknown[]) => {
  let text = "";
  for (const child of children) {
    if (!isAstNode(child)) {
      return null;
    }
    if (child.type === "JSXText" && typeof child.value === "string") {
      text += child.value;
      continue;
    }
    if (
      child.type !== "JSXExpressionContainer" ||
      !isAstNode(child.expression)
    ) {
      return null;
    }
    if (child.expression.type === "JSXEmptyExpression") {
      continue;
    }
    const value = staticStringValue(child.expression);
    if (value === null) {
      return null;
    }
    text += value;
  }
  return text;
};

export default eslintCompatPlugin({
  meta: { name: "no-placeholder-stella-mark" },
  rules: {
    "no-placeholder-stella-mark": {
      meta: {
        type: "problem",
        messages: { placeholderMark: PLACEHOLDER_STELLA_MARK_MESSAGE },
      },
      createOnce(context) {
        return {
          JSXElement(node) {
            const opening = node.openingElement;
            const name = jsxName(opening.name);
            if (
              !(name !== null && isStellaBrandIdentifier(name)) &&
              !opening.attributes.some(attributeNamesBrand)
            ) {
              return;
            }
            const text = onlyStaticChildText(node.children);
            if (text !== null && isPlaceholderStellaMark(text)) {
              context.report({ node: opening, messageId: "placeholderMark" });
            }
          },
        };
      },
    },
  },
});
