import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const WEB_SOURCE_PATH = "/apps/web/src/";

// The destination shape is meaningful in the web router and modules that
// import its route types. Other `to` fields, such as test or config data, are
// outside this rule's ownership boundary.
const isRouterLinkFile = (program: unknown, filename: string) => {
  if (filename.includes(WEB_SOURCE_PATH)) {
    return true;
  }
  if (!isAstNode(program) || !Array.isArray(program.body)) {
    return false;
  }
  return program.body.some(
    (statement) =>
      isAstNode(statement) &&
      statement.type === "ImportDeclaration" &&
      isAstNode(statement.source) &&
      statement.source.type === "Literal" &&
      statement.source.value === "@tanstack/react-router",
  );
};

const hasRouteDestination = (node: unknown) => {
  if (
    !isAstNode(node) ||
    node.type !== "ObjectExpression" ||
    !Array.isArray(node.properties)
  ) {
    return false;
  }
  return node.properties.some((property) => {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      getPropertyName(property.key) !== "to"
    ) {
      return false;
    }
    return (
      isStringLiteral(property.value) && property.value.value.startsWith("/")
    );
  });
};

const isLinkOptionsCallee = (callee: unknown) =>
  isIdentifier(callee, "linkOptions") ||
  (isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    getPropertyName(callee.property) === "linkOptions");

const isAllowedPlacement = (node: unknown) => {
  if (!isAstNode(node) || !isAstNode(node.parent)) {
    return false;
  }
  const parent = node.parent;
  if (parent.type === "CallExpression" || parent.type === "NewExpression") {
    return Array.isArray(parent.arguments) && parent.arguments.includes(node);
  }
  if (parent.type === "ArrayExpression" && isAstNode(parent.parent)) {
    const call = parent.parent;
    return (
      call.type === "CallExpression" &&
      isLinkOptionsCallee(call.callee) &&
      Array.isArray(call.arguments) &&
      call.arguments.includes(parent)
    );
  }
  if (parent.type === "JSXExpressionContainer" && isAstNode(parent.parent)) {
    return parent.parent.type === "JSXAttribute";
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "route-links" },
  rules: {
    "detached-link-options": {
      meta: {
        type: "problem",
        messages: {
          detached:
            "Build a route link outside a call with linkOptions(): a plain object widens `to` to string and the router stops checking its params and search.",
        },
      },
      create(context) {
        let inScope = false;
        return {
          Program(node) {
            inScope = isRouterLinkFile(node, filenameForContext(context));
          },
          ObjectExpression(node) {
            if (
              inScope &&
              hasRouteDestination(node) &&
              !isAllowedPlacement(node)
            ) {
              context.report({ node, messageId: "detached" });
            }
          },
        };
      },
    },
  },
});
