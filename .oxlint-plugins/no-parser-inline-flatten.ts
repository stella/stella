// Parser helpers that accept Inline arrays and return text delegate to the
// legal-ast projection owner. Reading leaf text in such a helper loses numeric
// superscript boundaries. Detects declared string/string[] returns, imported
// Inline aliases, member reads and destructuring. Inferred returns, local type
// aliases and opaque helper calls are outside this syntactic guard. Inline tree
// transforms and source DOM text readers retain their separate contracts.
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  memberPropertyName,
} from "./utils.ts";

const unwrapType = (value: unknown) => {
  let node = isAstNode(value) ? value : null;
  while (
    node?.type === "TSTypeAnnotation" ||
    node?.type === "TSTypeOperator" ||
    node?.type === "TSParenthesizedType"
  ) {
    node = isAstNode(node.typeAnnotation) ? node.typeAnnotation : null;
  }
  return node;
};

export default eslintCompatPlugin({
  meta: { name: "no-parser-inline-flatten" },
  rules: {
    "no-parser-inline-flatten": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          projection:
            "Project inline text through flattenInlineText from @stll/legal-ast/inline; use plainTextOf only for renderer offsets and cuts.",
        },
      },
      createOnce(context) {
        const inlineNames = new Set<string>();
        const projections: boolean[] = [];
        const enterFunction = (value: unknown) => {
          if (!isAstNode(value)) {
            return;
          }
          const returned = unwrapType(value.returnType);
          const textReturn =
            returned?.type === "TSStringKeyword" ||
            (returned?.type === "TSArrayType" &&
              unwrapType(returned.elementType)?.type === "TSStringKeyword");
          const inlineParam =
            Array.isArray(value.params) &&
            value.params.some((parameter) => {
              if (!isAstNode(parameter)) {
                return false;
              }
              const array = unwrapType(parameter.typeAnnotation);
              if (array?.type !== "TSArrayType") {
                return false;
              }
              const element = unwrapType(array.elementType);
              return (
                element?.type === "TSTypeReference" &&
                isIdentifier(element.typeName) &&
                inlineNames.has(element.typeName.name)
              );
            });
          projections.push(textReturn && inlineParam);
        };
        const exitFunction = () => {
          projections.pop();
        };
        return {
          Program() {
            inlineNames.clear();
            projections.length = 0;
          },
          ImportSpecifier(node) {
            if (getPropertyName(node.imported) === "Inline") {
              inlineNames.add(node.local.name);
            }
          },
          ArrowFunctionExpression: enterFunction,
          "ArrowFunctionExpression:exit": exitFunction,
          FunctionExpression: enterFunction,
          "FunctionExpression:exit": exitFunction,
          FunctionDeclaration: enterFunction,
          "FunctionDeclaration:exit": exitFunction,
          MemberExpression(node) {
            if (
              projections.includes(true) &&
              memberPropertyName(node) === "text"
            ) {
              context.report({ node, messageId: "projection" });
            }
          },
          ObjectPattern(node) {
            if (!projections.includes(true)) {
              return;
            }
            for (const property of node.properties) {
              if (
                isAstNode(property) &&
                property.type === "Property" &&
                getPropertyName(property.key) === "text"
              ) {
                context.report({ node: property, messageId: "projection" });
              }
            }
          },
        };
      },
    },
  },
});
