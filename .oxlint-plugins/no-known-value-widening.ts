// Same-file evidence only: API calls, mutable values, and public contracts are
// boundaries, not proof that a broad type is redundant.
import {
  eslintCompatPlugin,
  type Context,
  type ESTree,
  type Variable,
} from "@oxlint/plugins";

import { isAstNode, isIdentifier, unwrapExpression } from "./utils.ts";

const isReference = (node: unknown): node is ESTree.IdentifierReference =>
  isIdentifier(node);

const resolveVariable = (
  context: Context,
  node: ESTree.IdentifierReference,
) => {
  let scope: ReturnType<typeof context.sourceCode.getScope> | null =
    context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

const unwrapType = (value: unknown) => {
  let node = isAstNode(value) ? value : null;
  while (
    node?.type === "TSTypeAnnotation" ||
    node?.type === "TSParenthesizedType" ||
    (node?.type === "TSTypeOperator" && node.operator === "readonly")
  ) {
    node = isAstNode(node.typeAnnotation) ? node.typeAnnotation : null;
  }
  return node;
};

const resolveType = (
  context: Context,
  value: unknown,
  seen = new Set<Variable>(),
) => {
  let node = unwrapType(value);
  while (node?.type === "TSTypeReference" && isReference(node.typeName)) {
    const variable = resolveVariable(context, node.typeName);
    const definition = variable?.defs.at(0)?.node;
    if (
      variable === null ||
      !isAstNode(definition) ||
      definition.type !== "TSTypeAliasDeclaration"
    ) {
      break;
    }
    if (seen.has(variable)) {
      return null;
    }
    seen.add(variable);
    node = unwrapType(definition.typeAnnotation);
  }
  return node;
};

const broadKey = (
  context: Context,
  value: unknown,
  seen = new Set<Variable>(),
): boolean => {
  const node = resolveType(context, value, seen);
  return (
    node?.type === "TSStringKeyword" ||
    node?.type === "TSNumberKeyword" ||
    node?.type === "TSSymbolKeyword" ||
    (node?.type === "TSUnionType" &&
      Array.isArray(node.types) &&
      node.types.some((member) => broadKey(context, member, new Set(seen))))
  );
};

const broadTarget = (
  context: Context,
  value: unknown,
): "unknown" | "object" | "open dictionary" | null => {
  const node = resolveType(context, value);
  if (node?.type === "TSUnknownKeyword") {
    return "unknown";
  }
  if (node?.type === "TSObjectKeyword") {
    return "object";
  }
  if (
    node?.type === "TSTypeReference" &&
    isReference(node.typeName) &&
    node.typeName.name === "Record" &&
    isAstNode(node.typeArguments) &&
    Array.isArray(node.typeArguments.params) &&
    broadKey(context, node.typeArguments.params.at(0))
  ) {
    const binding = resolveVariable(context, node.typeName);
    if (binding === null || binding.defs.length === 0) {
      return "open dictionary";
    }
  }
  if (
    node?.type === "TSTypeLiteral" &&
    Array.isArray(node.members) &&
    node.members.some((member) => {
      if (
        !isAstNode(member) ||
        member.type !== "TSIndexSignature" ||
        !Array.isArray(member.parameters)
      ) {
        return false;
      }
      const parameter = member.parameters.at(0);
      return (
        isAstNode(parameter) && broadKey(context, parameter.typeAnnotation)
      );
    })
  ) {
    return "open dictionary";
  }
  return null;
};

const knownEvidence = (
  context: Context,
  value: unknown,
  seen = new Set<Variable>(),
): boolean => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  if (node.type === "Literal" || node.type === "TemplateLiteral") {
    return true;
  }
  if (node.type === "ObjectExpression") {
    return (
      Array.isArray(node.properties) &&
      node.properties.some(
        (property) => isAstNode(property) && property.type === "Property",
      )
    );
  }
  if (node.type === "ArrayExpression") {
    return Array.isArray(node.elements) && node.elements.length > 0;
  }
  if (!isReference(node)) {
    return false;
  }
  const variable = resolveVariable(context, node);
  if (variable === null || seen.has(variable)) {
    return false;
  }
  const definition = variable.defs.at(0);
  if (
    definition?.type !== "Variable" ||
    !isAstNode(definition.node) ||
    definition.parent?.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const" ||
    variable.references.some(
      (reference) => !reference.init && reference.isWrite(),
    )
  ) {
    return false;
  }
  seen.add(variable);
  return knownEvidence(context, definition.node.init, seen);
};

const ownerVariable = (context: Context, expression: unknown) => {
  if (!isAstNode(expression)) {
    return null;
  }
  let parent = expression.parent;
  if (
    isAstNode(parent) &&
    (parent.type === "TSAsExpression" || parent.type === "TSTypeAssertion")
  ) {
    parent = parent.parent;
  }
  return isAstNode(parent) &&
    parent.type === "VariableDeclarator" &&
    isReference(parent.id)
    ? resolveVariable(context, parent.id)
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-known-value-widening" },
  rules: {
    "no-known-value-widening": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          widening:
            "This explicit {{target}} type discards known local evidence. Keep inference or use `satisfies` to check the contract without erasing it.",
        },
      },
      createOnce(context) {
        const report = (expression: unknown, annotation: unknown) => {
          const target = broadTarget(context, annotation);
          if (
            target === null ||
            !isAstNode(expression) ||
            !knownEvidence(context, expression)
          ) {
            return;
          }
          const parent = expression.parent;
          // Double assertions already have a dedicated safety-rationale guard.
          if (
            isAstNode(parent) &&
            (parent.type === "TSAsExpression" ||
              parent.type === "TSTypeAssertion") &&
            isAstNode(parent.parent) &&
            (parent.parent.type === "TSAsExpression" ||
              parent.parent.type === "TSTypeAssertion")
          ) {
            return;
          }
          const owner = ownerVariable(context, expression);
          const reads =
            owner?.references.filter((reference) => reference.isRead()) ?? [];
          // A call argument crosses a contract boundary. Do not guess that
          // contract from a validator-looking function name.
          if (
            reads.some(
              ({ identifier }) =>
                identifier.parent.type === "CallExpression" &&
                identifier.parent.arguments.some(
                  (argument) => argument === identifier,
                ),
            )
          ) {
            return;
          }
          if (
            target === "open dictionary" &&
            !reads.some(
              ({ identifier }) =>
                (identifier.parent.type === "TSAsExpression" ||
                  identifier.parent.type === "TSTypeAssertion") &&
                broadTarget(context, identifier.parent.typeAnnotation) === null,
            )
          ) {
            return;
          }
          context.report({
            node: expression,
            messageId: "widening",
            data: { target },
          });
        };
        return {
          VariableDeclarator(node) {
            if (
              node.parent.type === "VariableDeclaration" &&
              node.parent.kind === "const" &&
              node.id.type === "Identifier"
            ) {
              report(node.init, node.id.typeAnnotation);
            }
          },
          TSAsExpression(node) {
            report(node.expression, node.typeAnnotation);
          },
          TSTypeAssertion(node) {
            report(node.expression, node.typeAnnotation);
          },
        };
      },
    },
  },
});
