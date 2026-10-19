import { eslintCompatPlugin } from "@oxlint/plugins";

import { repoRelativePath } from "@stll/portable-path";

import {
  type ScopeContext,
  filenameForContext,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  patternKeyFor,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

// Event builders and the transactional classifier are the only brand sources.
// Detection follows stable local aliases (including destructuring), not calls
// or mutable values; the typed broadcast boundary checks the remaining paths.
const CONTRACT_OWNER = "packages/api-contract/src/realtime-events.ts";
const CLASSIFIER_OWNER = "apps/api/src/lib/flows/visibility.ts";
const BRAND_NAME =
  /^(?:ClassifiedEntityDeletionOwnership|BuiltRealtimeEvent)$/u;

const namedConstant = (
  context: ScopeContext,
  node: unknown,
  name: string,
): boolean => {
  const expression = unwrapExpression(node);
  return (
    isIdentifier(expression, name) ||
    resolveImportedExpressionForEnforcement(context, expression)?.imported ===
      name
  );
};

const deletionValue = (
  context: ScopeContext,
  node: unknown,
  seen = new Set<unknown>(),
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  const literal = staticStringValue(expression);
  if (literal !== null) {
    return literal;
  }
  if (expression.type === "MemberExpression") {
    const key = memberPropertyName(expression);
    if (
      key === "RESOURCE_DELETED" &&
      namedConstant(context, expression.object, "REALTIME_EVENT_TYPE")
    ) {
      return "resource.deleted";
    }
    if (
      key === "DELETED" &&
      namedConstant(context, expression.object, "RESOURCE_CHANGE_TYPE")
    ) {
      return "resource-change.deleted";
    }
  }
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  if (variable === null) {
    return null;
  }
  const init = stableInitializer(variable);
  const definition = variable.defs.at(0);
  if (init === null || !isAstNode(definition?.node)) {
    return null;
  }
  const pattern = definition.node.id;
  if (isAstNode(pattern) && pattern.type === "ObjectPattern") {
    const key = patternKeyFor(pattern, definition.name);
    if (
      key === "RESOURCE_DELETED" &&
      namedConstant(context, init, "REALTIME_EVENT_TYPE")
    ) {
      return "resource.deleted";
    }
    if (
      key === "DELETED" &&
      namedConstant(context, init, "RESOURCE_CHANGE_TYPE")
    ) {
      return "resource-change.deleted";
    }
    return null;
  }
  return deletionValue(context, init, seen);
};

const containsBrand = (
  context: ScopeContext,
  node: unknown,
  seen = new Set<unknown>(),
): boolean => {
  if (!isAstNode(node) || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isIdentifierReference(node)) {
    if (BRAND_NAME.test(node.name)) {
      return true;
    }
    const variable = resolveVariable(context, node);
    const definition = variable?.defs.at(0);
    if (isAstNode(definition?.node)) {
      const imported = getImportedName(definition.node);
      if (imported !== null && BRAND_NAME.test(imported)) {
        return true;
      }
      if (
        definition.node.type === "TSTypeAliasDeclaration" &&
        containsBrand(context, definition.node.typeAnnotation, seen)
      ) {
        return true;
      }
    }
  }
  return [
    node.typeName,
    node.typeAnnotation,
    node.typeArguments,
    node.types,
    node.params,
    node.left,
    node.right,
  ].some((child) =>
    Array.isArray(child)
      ? child.some((entry) => containsBrand(context, entry, seen))
      : containsBrand(context, child, seen),
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-forged-realtime-event" },
  rules: {
    "no-forged-realtime-event": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          brand:
            "Realtime event and entity deletion brands must originate in their canonical owners.",
          event:
            "Construct resource deletion events and changes through the realtime contract builders.",
        },
      },
      createOnce(context) {
        let contractOwner = false;
        let brandOwner = false;
        const checkBrandLiteral = (node: unknown) => {
          if (!isAstNode(node)) {
            return;
          }
          const value = staticStringValue(node);
          if (!brandOwner && value !== null && BRAND_NAME.test(value)) {
            context.report({ node, messageId: "brand" });
          }
        };
        const checkCast = (node: unknown) => {
          if (!isAstNode(node)) {
            return;
          }
          if (!brandOwner && containsBrand(context, node.typeAnnotation)) {
            context.report({ node, messageId: "brand" });
          }
        };
        return {
          before() {
            const filename = repoRelativePath(
              context.cwd,
              filenameForContext(context),
            );
            contractOwner = filename === CONTRACT_OWNER;
            brandOwner = contractOwner || filename === CLASSIFIER_OWNER;
          },
          Literal: checkBrandLiteral,
          TemplateLiteral: checkBrandLiteral,
          TSAsExpression: checkCast,
          TSTypeAssertion: checkCast,
          ObjectExpression(node) {
            if (contractOwner) {
              return;
            }
            const fields = node.properties.filter(
              (property) => property.type === "Property",
            );
            const resource = fields.some(
              (property) => getPropertyName(property.key) === "resource",
            );
            const deleted = fields.some((property) => {
              const key = getPropertyName(property.key);
              const value = deletionValue(context, property.value);
              return (
                (key === "type" && value === "resource.deleted") ||
                (key === "change" &&
                  (value === "resource-change.deleted" ||
                    (resource && value === "deleted")))
              );
            });
            if (deleted) {
              context.report({ node, messageId: "event" });
            }
          },
        };
      },
    },
  },
});
