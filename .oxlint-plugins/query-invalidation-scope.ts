import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  type FilenameContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isImportedFrom,
  type ScopeContext,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

// The module that owns the entity query keys and the collection predicate.
const ENTITY_KEYS_MODULE = "apps/web/src/lib/workspaces/queries/entities.logic";
const ENTITY_KEYS = new Set(["entitiesKeys"]);
const COLLECTION_PREDICATE = new Set(["isEntityCollectionQueryKey"]);

type RuleContext = ScopeContext & FilenameContext;

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
  // A later spread can replace a proven predicate.
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

const isOwnedImport = (
  context: RuleContext,
  node: unknown,
  names: ReadonlySet<string>,
) => isImportedFrom({ context, node, modules: [ENTITY_KEYS_MODULE], names });

const containsEntityRoot = (context: RuleContext, node: unknown): boolean => {
  if (Array.isArray(node)) {
    return node.some((child) => containsEntityRoot(context, child));
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
    isOwnedImport(context, callee.object, ENTITY_KEYS)
  ) {
    return true;
  }
  return Object.entries(node).some(
    ([key, value]) => key !== "parent" && containsEntityRoot(context, value),
  );
};

const hasCollectionPredicate = (
  context: RuleContext,
  options: unknown,
): boolean => {
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
    isOwnedImport(context, body.callee, COLLECTION_PREDICATE) &&
    Array.isArray(body.arguments) &&
    body.arguments.length === 1 &&
    isIdentifier(body.arguments.at(0), queryKey.value.name)
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
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              isAstNode(callee) &&
              callee.type === "MemberExpression" &&
              propertyName(callee) === "invalidateQueries" &&
              containsEntityRoot(context, node.arguments) &&
              !hasCollectionPredicate(
                context,
                unwrapExpression(node.arguments.at(0)),
              )
            ) {
              context.report({ node, messageId: "broadMutation" });
            }
          },
        };
      },
    },
  },
});
