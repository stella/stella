// Resource names and chat links carry opaque IDs. Constructing either format
// outside its canonical serializer can skip strict component encoding and
// break persistence or Markdown parsing for valid IDs.

import {
  eslintCompatPlugin,
  type ESTree,
  type Scope,
  type Variable,
} from "@oxlint/plugins";

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isCallTo,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const RAW_RESOURCE_URI_PREFIXES = [
  "#stella-decision=",
  "#stella-entity=",
  "#stella-workspace=",
  "stella://resource/",
] as const;

const RESOURCE_URI_PREFIX_BINDINGS = new Set([
  "CHAT_MENTION_HREF_PREFIXES",
  "CHAT_REFERENCE_HREF_PREFIXES",
  "CHAT_RESOURCE_HREF_PREFIX",
  "RESOURCE_NAME_PREFIX",
]);

const containsRawResourceUriPrefix = (value: string): boolean =>
  RAW_RESOURCE_URI_PREFIXES.some((prefix) => value.includes(prefix));

const isScopeIdentifier = (
  value: unknown,
): value is ESTree.IdentifierReference => isIdentifier(value);

const templateElementText = (value: unknown): string | null => {
  if (!isAstNode(value) || value.type !== "TemplateElement") {
    return null;
  }
  const templateValue = value.value;
  if (typeof templateValue !== "object" || templateValue === null) {
    return null;
  }
  const cooked = Object.getOwnPropertyDescriptor(
    templateValue,
    "cooked",
  )?.value;
  if (typeof cooked === "string") {
    return cooked;
  }
  const raw = Object.getOwnPropertyDescriptor(templateValue, "raw")?.value;
  return typeof raw === "string" ? raw : null;
};

const templateContainsRawResourceUriPrefix = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "TemplateLiteral" &&
  Array.isArray(node.quasis) &&
  node.quasis.some((quasi) => {
    const text = templateElementText(quasi);
    return text !== null && containsRawResourceUriPrefix(text);
  });

export default eslintCompatPlugin({
  meta: { name: "no-raw-resource-uri" },
  rules: {
    "no-raw-resource-uri": {
      meta: {
        type: "problem",
        messages: {
          rawResourceUri:
            "Construct resource names with toResourceName() and chat links " +
            "with toChatResourceHref() or toChatMentionResourceHref(); the " +
            "canonical serializers encode opaque IDs safely.",
        },
      },
      createOnce(context) {
        const resolveVariable = (identifier: unknown): Variable | null => {
          if (!isScopeIdentifier(identifier)) {
            return null;
          }
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope) {
            const variable = scope.set.get(identifier.name);
            if (variable) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const getStableInitializer = (variable: Variable): unknown => {
          for (const definition of variable.defs) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration"
            ) {
              continue;
            }
            if (
              definition.parent.kind !== "const" &&
              variable.references.some(
                (reference) =>
                  typeof reference.isWrite === "function" &&
                  reference.isWrite() &&
                  reference.init !== true,
              )
            ) {
              return null;
            }
            return definition.node.init;
          }
          return null;
        };

        const isResourcePrefixNamespaceMember = (node: unknown): boolean => {
          if (
            !isAstNode(node) ||
            node.type !== "MemberExpression" ||
            !isIdentifier(node.object)
          ) {
            return false;
          }
          const propertyName = getPropertyName(node.property);
          if (
            propertyName === null ||
            !RESOURCE_URI_PREFIX_BINDINGS.has(propertyName)
          ) {
            return false;
          }
          const variable = resolveVariable(node.object);
          return (
            variable?.defs.some(
              (definition) =>
                definition.type === "ImportBinding" &&
                isAstNode(definition.node) &&
                definition.node.type === "ImportNamespaceSpecifier",
            ) ?? false
          );
        };

        const referencesResourceUriPrefix = (
          value: unknown,
          visited = new Set<unknown>(),
        ): boolean => {
          const node = unwrapExpression(value);
          if (node === null) {
            return false;
          }
          if (isIdentifier(node)) {
            const variable = resolveVariable(node);
            if (variable === null) {
              return RESOURCE_URI_PREFIX_BINDINGS.has(node.name);
            }
            if (visited.has(variable)) {
              return false;
            }
            visited.add(variable);
            if (
              variable.defs.some(
                (definition) =>
                  definition.type === "ImportBinding" &&
                  RESOURCE_URI_PREFIX_BINDINGS.has(
                    getImportedName(definition.node) ?? "",
                  ),
              )
            ) {
              return true;
            }
            return referencesResourceUriPrefix(
              getStableInitializer(variable),
              visited,
            );
          }
          if (node.type === "MemberExpression") {
            return (
              isResourcePrefixNamespaceMember(node) ||
              referencesResourceUriPrefix(node.object, visited)
            );
          }
          if (
            node.type === "BinaryExpression" ||
            node.type === "LogicalExpression"
          ) {
            return (
              referencesResourceUriPrefix(node.left, visited) ||
              referencesResourceUriPrefix(node.right, visited)
            );
          }
          if (node.type === "ConditionalExpression") {
            return (
              referencesResourceUriPrefix(node.consequent, visited) ||
              referencesResourceUriPrefix(node.alternate, visited)
            );
          }
          if (node.type === "TemplateLiteral") {
            return (
              Array.isArray(node.expressions) &&
              node.expressions.some((expression) =>
                referencesResourceUriPrefix(expression, visited),
              )
            );
          }
          if (node.type === "ObjectExpression") {
            return (
              Array.isArray(node.properties) &&
              node.properties.some((property) => {
                if (!isAstNode(property)) {
                  return false;
                }
                if (property.type === "SpreadElement") {
                  return referencesResourceUriPrefix(
                    property.argument,
                    visited,
                  );
                }
                return (
                  property.type === "Property" &&
                  referencesResourceUriPrefix(property.value, visited)
                );
              })
            );
          }
          return false;
        };

        const isConcatCallOnResourceUriPrefix = (node: unknown): boolean => {
          if (!isAstNode(node) || node.type !== "CallExpression") {
            return false;
          }
          const callee = node.callee;
          return (
            isAstNode(callee) &&
            callee.type === "MemberExpression" &&
            getPropertyName(callee.property) === "concat" &&
            referencesResourceUriPrefix(callee.object)
          );
        };

        const report = (node: unknown): void => {
          if (isAstNode(node)) {
            context.report({ node, messageId: "rawResourceUri" });
          }
        };

        return {
          BinaryExpression(node) {
            if (
              node.operator === "+" &&
              (referencesResourceUriPrefix(node.left) ||
                referencesResourceUriPrefix(node.right))
            ) {
              report(node);
            }
          },
          CallExpression(node) {
            if (isConcatCallOnResourceUriPrefix(node)) {
              report(node);
            }
          },
          Literal(node) {
            if (
              isStringLiteral(node) &&
              containsRawResourceUriPrefix(node.value)
            ) {
              report(node);
            }
          },
          TemplateLiteral(node) {
            if (
              templateContainsRawResourceUriPrefix(node) ||
              (Array.isArray(node.expressions) &&
                node.expressions.some((expression) =>
                  referencesResourceUriPrefix(expression),
                ))
            ) {
              report(node);
            }
          },
        };
      },
    },
    "require-rfc3986-resource-encoding": {
      meta: {
        type: "problem",
        messages: {
          strictResourceEncoding:
            "Encode opaque resource IDs with encodeRfc3986Component(), not " +
            "encodeURIComponent().",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (isCallTo(node, "encodeURIComponent")) {
              context.report({
                node,
                messageId: "strictResourceEncoding",
              });
            }
          },
        };
      },
    },
  },
});
