// Parser helpers that accept Inline arrays and return text delegate to the
// legal-ast projection owner. Reading leaf text in such a helper loses numeric
// superscript boundaries. Detects declared string/string[] returns, imported
// Inline aliases, and member reads and destructuring of the nodes those
// arrays hold (through for-of, array-method callbacks and `children`). Inferred
// returns, local type aliases and opaque helper calls are outside this
// syntactic guard. Inline tree transforms and source DOM text readers, in the
// same helper or not, retain their separate contracts.
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
        // Names bound to the projection's Inline arrays and to their nodes.
        // Only a read through one of them is an inline leaf read; source
        // nodes the helper also reads keep their own `.text`.
        const arrays = new Set<string>();
        const nodes = new Set<string>();
        const isInlineArrayParameter = (parameter: unknown) => {
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
        };
        // An array of inline nodes: a tracked array, a node's children, or
        // an array method's result on one.
        const isInlineArray = (value: unknown): boolean => {
          if (isIdentifier(value)) {
            return arrays.has(value.name);
          }
          if (!isAstNode(value)) {
            return false;
          }
          if (value.type === "MemberExpression") {
            return (
              memberPropertyName(value) === "children" &&
              isInlineNode(value.object)
            );
          }
          if (value.type === "CallExpression" && isAstNode(value.callee)) {
            return (
              value.callee.type === "MemberExpression" &&
              isInlineArray(value.callee.object)
            );
          }
          return false;
        };
        const isInlineNode = (value: unknown): boolean =>
          (isIdentifier(value) && nodes.has(value.name)) ||
          (isAstNode(value) &&
            value.type === "MemberExpression" &&
            value.computed === true &&
            isInlineArray(value.object));
        const reportTextPattern = (pattern: unknown) => {
          if (!isAstNode(pattern) || pattern.type !== "ObjectPattern") {
            return;
          }
          for (const property of Array.isArray(pattern.properties)
            ? pattern.properties
            : []) {
            if (
              isAstNode(property) &&
              property.type === "Property" &&
              getPropertyName(property.key) === "text"
            ) {
              context.report({ node: property, messageId: "projection" });
            }
          }
        };
        // A binding that names one inline node: tracked, or read for `text`.
        const bindNode = (binding: unknown) => {
          if (isIdentifier(binding)) {
            nodes.add(binding.name);
            return;
          }
          reportTextPattern(binding);
        };
        const enterFunction = (value: unknown) => {
          if (!isAstNode(value)) {
            return;
          }
          const returned = unwrapType(value.returnType);
          const textReturn =
            returned?.type === "TSStringKeyword" ||
            (returned?.type === "TSArrayType" &&
              unwrapType(returned.elementType)?.type === "TSStringKeyword");
          const params = Array.isArray(value.params) ? value.params : [];
          const inlineParams = params.filter(isInlineArrayParameter);
          const projection = textReturn && inlineParams.length > 0;
          if (projection) {
            for (const parameter of inlineParams) {
              if (isIdentifier(parameter)) {
                arrays.add(parameter.name);
              }
            }
          }
          projections.push(projection);
        };
        const exitFunction = () => {
          projections.pop();
          if (!projections.includes(true)) {
            arrays.clear();
            nodes.clear();
          }
        };
        return {
          Program() {
            inlineNames.clear();
            projections.length = 0;
            arrays.clear();
            nodes.clear();
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
          ForOfStatement(node) {
            if (!projections.includes(true) || !isInlineArray(node.right)) {
              return;
            }
            const left = node.left;
            if (isAstNode(left) && left.type === "VariableDeclaration") {
              for (const declaration of left.declarations) {
                bindNode(declaration.id);
              }
            }
          },
          // An array method's callback receives one inline node first.
          CallExpression(node) {
            if (
              !projections.includes(true) ||
              !isAstNode(node.callee) ||
              node.callee.type !== "MemberExpression" ||
              !isInlineArray(node.callee.object)
            ) {
              return;
            }
            const callback = node.arguments.at(0);
            if (
              isAstNode(callback) &&
              (callback.type === "ArrowFunctionExpression" ||
                callback.type === "FunctionExpression") &&
              Array.isArray(callback.params)
            ) {
              bindNode(callback.params.at(0));
            }
          },
          MemberExpression(node) {
            if (
              projections.includes(true) &&
              memberPropertyName(node) === "text" &&
              isInlineNode(node.object)
            ) {
              context.report({ node, messageId: "projection" });
            }
          },
        };
      },
    },
  },
});
