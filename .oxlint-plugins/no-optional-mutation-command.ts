// Require React Query mutation commands to preserve operation identity.
//
// A mutation parameter with multiple optional domain fields admits an empty
// command and several unrelated operations at once. It also forces success
// effects to infer intent from field presence, which allowed a workspace color
// update to inherit rename-only route invalidation. Use a discriminated union;
// one variant may still carry a compound payload when fields form one atomic
// operation.
//
// Flagged:
//   useMutation({
//     mutationFn: async (body: { name?: string; color?: string }) => save(body),
//   })
//
// Allowed:
//   type Update =
//     | { type: "name"; value: string }
//     | { type: "color"; value: string };
//   useMutation({ mutationFn: async (update: Update) => save(update) })

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportLocalName,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const REACT_QUERY_MODULE = "@tanstack/react-query";

const isIdentityProperty = (name: string | null) =>
  name === "id" || name?.endsWith("Id") === true;

const isAmbiguousOptionalBag = (typeNode: unknown): boolean => {
  if (!isAstNode(typeNode)) {
    return false;
  }
  if (typeNode.type === "TSTypeLiteral") {
    const members = Array.isArray(typeNode.members) ? typeNode.members : [];
    const propertyMembers = members.filter(
      (member) =>
        isAstNode(member) &&
        member.type === "TSPropertySignature",
    );
    const optionalCount = propertyMembers.filter(
      (member) => member.optional === true,
    ).length;
    const hasRequiredDomainField = propertyMembers.some(
      (member) =>
        member.optional !== true &&
        !isIdentityProperty(getPropertyName(member.key)),
    );
    return optionalCount >= 2 && !hasRequiredDomainField;
  }
  return false;
};

const parameterType = (parameter: unknown) => {
  if (!isAstNode(parameter)) {
    return null;
  }
  const annotation = parameter.typeAnnotation;
  if (!isAstNode(annotation) || annotation.type !== "TSTypeAnnotation") {
    return null;
  }
  return isAstNode(annotation.typeAnnotation) ? annotation.typeAnnotation : null;
};

const mutationFunctionFromOptions = (options: unknown) => {
  if (!isAstNode(options) || options.type !== "ObjectExpression") {
    return null;
  }
  const properties = Array.isArray(options.properties) ? options.properties : [];
  for (const property of properties) {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      getPropertyName(property.key) !== "mutationFn"
    ) {
      continue;
    }
    return isAstNode(property.value) ? property.value : null;
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-optional-mutation-command" },
  rules: {
    "no-optional-mutation-command": {
      meta: {
        type: "problem",
        messages: {
          optionalBag:
            "Mutation commands with multiple optional domain fields lose " +
            "operation identity and admit empty or conflicting updates. Use " +
            "a discriminated union with one explicit variant per operation.",
        },
      },
      createOnce(context) {
        const useMutationNames = new Set<string>();
        const localTypeNodes = new Map<string, unknown>();

        return {
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              node.source.value !== REACT_QUERY_MODULE
            ) {
              return;
            }
            const specifiers = Array.isArray(node.specifiers)
              ? node.specifiers
              : [];
            for (const specifier of specifiers) {
              if (getImportedName(specifier) !== "useMutation") {
                continue;
              }
              const localName = getImportLocalName(specifier);
              if (localName !== null) {
                useMutationNames.add(localName);
              }
            }
          },
          TSTypeAliasDeclaration(node) {
            if (isIdentifier(node.id) && isAstNode(node.typeAnnotation)) {
              localTypeNodes.set(node.id.name, node.typeAnnotation);
            }
          },
          CallExpression(node) {
            if (
              !isIdentifier(node.callee) ||
              !useMutationNames.has(node.callee.name)
            ) {
              return;
            }
            const mutationFunction = mutationFunctionFromOptions(
              node.arguments?.[0],
            );
            if (
              !isAstNode(mutationFunction) ||
              (mutationFunction.type !== "ArrowFunctionExpression" &&
                mutationFunction.type !== "FunctionExpression")
            ) {
              return;
            }
            const parameter = mutationFunction.params?.[0];
            const typeNode = parameterType(parameter);
            if (typeNode === null) {
              return;
            }
            const resolvedType =
              typeNode.type === "TSTypeReference" &&
              isIdentifier(typeNode.typeName)
                ? localTypeNodes.get(typeNode.typeName.name)
                : typeNode;
            if (!isAmbiguousOptionalBag(resolvedType)) {
              return;
            }
            context.report({ node: parameter, messageId: "optionalBag" });
          },
        };
      },
    },
  },
});
