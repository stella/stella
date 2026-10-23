import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isAstNode,
  isIdentifier,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const INFINITE_FACTORIES = new Set([
  "useInfiniteQuery",
  "infiniteQueryOptions",
]);

const propertyName = (node: AstNode) =>
  node.computed
    ? staticStringValue(node.key ?? node.property)
    : getPropertyName(node.key ?? node.property);

const objectProperty = (node: unknown, name: string): AstNode | undefined => {
  if (
    !isAstNode(node) ||
    node.type !== "ObjectExpression" ||
    !Array.isArray(node.properties)
  ) {
    return undefined;
  }
  // A later spread can replace a proven predicate or page limit.
  let found: AstNode | undefined;
  for (const property of node.properties) {
    if (!isAstNode(property)) {
      continue;
    }
    if (property.type === "SpreadElement") {
      found = undefined;
    }
    if (property.type === "Property" && propertyName(property) === name) {
      found = property;
    }
  }
  return found;
};

const containsEntityRoot = (node: unknown): boolean => {
  if (Array.isArray(node)) {
    return node.some(containsEntityRoot);
  }
  if (!isAstNode(node)) {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (
    node.type === "CallExpression" &&
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    propertyName(callee) === "all" &&
    isIdentifier(callee.object, "entitiesKeys")
  ) {
    return true;
  }
  return Object.entries(node).some(
    ([key, value]) => key !== "parent" && containsEntityRoot(value),
  );
};

const hasCollectionPredicate = (options: unknown): boolean => {
  const predicate = unwrapExpression(
    objectProperty(options, "predicate")?.value,
  );
  if (
    !isAstNode(predicate) ||
    predicate.type !== "ArrowFunctionExpression" ||
    !Array.isArray(predicate.params)
  ) {
    return false;
  }
  const parameter = predicate.params.at(0);
  if (
    !isAstNode(parameter) ||
    parameter.type !== "ObjectPattern" ||
    !Array.isArray(parameter.properties)
  ) {
    return false;
  }
  const queryKey = parameter.properties.find(
    (property) =>
      isAstNode(property) &&
      property.type === "Property" &&
      propertyName(property) === "queryKey",
  );
  if (!isAstNode(queryKey) || !isIdentifier(queryKey.value)) {
    return false;
  }
  const body = unwrapExpression(predicate.body);
  return (
    isAstNode(body) &&
    body.type === "CallExpression" &&
    isIdentifier(body.callee, "isEntityCollectionQueryKey") &&
    Array.isArray(body.arguments) &&
    body.arguments.length === 1 &&
    isIdentifier(body.arguments.at(0), queryKey.value.name)
  );
};

const hasPageBudget = (options: unknown): boolean => {
  const value = unwrapExpression(objectProperty(options, "maxPages")?.value);
  return (
    isAstNode(value) &&
    value.type === "Literal" &&
    typeof value.value === "number" &&
    Number.isSafeInteger(value.value) &&
    value.value > 0
  );
};

export default eslintCompatPlugin({
  meta: { name: "query-invalidation-scope" },
  rules: {
    "query-invalidation-scope": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          broadMutation:
            "Entity-root invalidation must use isEntityCollectionQueryKey as its predicate; invalidate changed details separately.",
          unboundedInfinite:
            "Infinite queries must set maxPages to a positive finite integer literal so refetch work stays bounded.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            const options = unwrapExpression(node.arguments.at(0));
            if (
              isAstNode(callee) &&
              callee.type === "MemberExpression" &&
              propertyName(callee) === "invalidateQueries" &&
              containsEntityRoot(node.arguments) &&
              !hasCollectionPredicate(options)
            ) {
              context.report({ node, messageId: "broadMutation" });
            }
            if (
              isIdentifier(callee) &&
              INFINITE_FACTORIES.has(callee.name) &&
              !hasPageBudget(options)
            ) {
              context.report({ node, messageId: "unboundedInfinite" });
            }
          },
        };
      },
    },
  },
});
