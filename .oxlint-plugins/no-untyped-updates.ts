// Reject broad update bags only when they reach a Drizzle update sink.
//
// A `Record<string, unknown | any>` is useful for JSON and metadata, but it
// defeats Drizzle's column-level checking when passed to
// `db.update(table).set(...)`. Requiring both the broad annotation and the
// update-builder sink keeps the rule honest: unrelated records remain valid.
// Stable local aliases and object spreads are followed so a temporary const
// cannot launder the update bag before `.set(...)`.

import {
  eslintCompatPlugin,
  type Definition,
  type ESTree,
  type Scope,
  type Variable,
} from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference => isIdentifier(node);

const isObjectExpression = (node: unknown): node is ESTree.ObjectExpression =>
  isAstNode(node) && node.type === "ObjectExpression";

const isDrizzleUpdateSetCall = (node: ESTree.CallExpression): boolean => {
  const callee = unwrapExpression(node.callee);
  if (
    callee?.type !== "MemberExpression" ||
    getPropertyName(callee.property) !== "set"
  ) {
    return false;
  }

  const updateCall = unwrapExpression(callee.object);
  if (updateCall?.type !== "CallExpression") {
    return false;
  }

  const updateCallee = unwrapExpression(updateCall.callee);
  return (
    updateCallee?.type === "MemberExpression" &&
    getPropertyName(updateCallee.property) === "update"
  );
};

const isVariableDefinition = (
  definition: Definition,
): definition is Definition & { node: ESTree.VariableDeclarator } =>
  definition.type === "Variable" &&
  definition.node.type === "VariableDeclarator";

export default eslintCompatPlugin({
  meta: { name: "no-untyped-updates" },
  rules: {
    "no-untyped-updates": {
      meta: {
        type: "problem",
        messages: {
          untypedUpdate:
            "Do not pass a 'Record<string, unknown | any>' update bag to Drizzle .set(). Use a schema-derived or explicit update type.",
        },
      },
      createOnce(context) {
        const namedTypeAnnotations = new Map<Variable, unknown>();
        const setCalls: ESTree.CallExpression[] = [];
        const reported = new Set<Variable>();

        const resolveVariable = (identifier: unknown): Variable | null => {
          if (!isIdentifierReference(identifier)) {
            return null;
          }
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope !== null) {
            const variable = scope.set.get(identifier.name);
            if (variable !== undefined) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const isBroadRecordType = (
          node: unknown,
          seen = new Set<Variable>(),
        ): boolean => {
          const annotation =
            isAstNode(node) && node.type === "TSTypeAnnotation"
              ? node.typeAnnotation
              : node;
          if (
            !isAstNode(annotation) ||
            annotation.type !== "TSTypeReference" ||
            !isIdentifier(annotation.typeName)
          ) {
            return false;
          }
          if (annotation.typeName.name === "Record") {
            const parameters = isAstNode(annotation.typeArguments)
              ? annotation.typeArguments.params
              : undefined;
            return (
              Array.isArray(parameters) &&
              parameters.length === 2 &&
              parameters.at(0)?.type === "TSStringKeyword" &&
              (parameters.at(1)?.type === "TSUnknownKeyword" ||
                parameters.at(1)?.type === "TSAnyKeyword")
            );
          }

          const variable = resolveVariable(annotation.typeName);
          if (variable === null || seen.has(variable)) {
            return false;
          }
          const declaration = namedTypeAnnotations.get(variable);
          if (
            !isAstNode(declaration) ||
            declaration.type !== "TSTypeAliasDeclaration"
          ) {
            return false;
          }
          const nextSeen = new Set(seen);
          nextSeen.add(variable);
          return isBroadRecordType(declaration.typeAnnotation, nextSeen);
        };

        const staticPropertyName = (property: unknown): string | null => {
          if (
            !isAstNode(property) ||
            (property.type !== "Property" &&
              property.type !== "TSPropertySignature")
          ) {
            return null;
          }
          if (property.computed !== true) {
            return getPropertyName(property.key);
          }
          return isStringLiteral(property.key) ? property.key.value : null;
        };

        const propertyType = (
          node: unknown,
          propertyName: string,
          seen = new Set<Variable>(),
        ): unknown => {
          const annotation =
            isAstNode(node) && node.type === "TSTypeAnnotation"
              ? node.typeAnnotation
              : node;
          if (!isAstNode(annotation)) {
            return null;
          }
          if (
            annotation.type === "TSTypeReference" &&
            isIdentifierReference(annotation.typeName)
          ) {
            const variable = resolveVariable(annotation.typeName);
            if (variable === null || seen.has(variable)) {
              return null;
            }
            const declaration = namedTypeAnnotations.get(variable);
            if (
              !isAstNode(declaration) ||
              declaration.type !== "TSTypeAliasDeclaration"
            ) {
              return null;
            }
            const nextSeen = new Set(seen);
            nextSeen.add(variable);
            return propertyType(
              declaration.typeAnnotation,
              propertyName,
              nextSeen,
            );
          }
          if (
            annotation.type !== "TSTypeLiteral" ||
            !Array.isArray(annotation.members)
          ) {
            return null;
          }
          for (const member of annotation.members) {
            if (
              isAstNode(member) &&
              member.type === "TSPropertySignature" &&
              staticPropertyName(member) === propertyName
            ) {
              return member.typeAnnotation;
            }
          }
          return null;
        };

        const patternContainsVariable = (
          pattern: unknown,
          variable: Variable,
        ): boolean =>
          isAstNode(pattern) &&
          variable.identifiers.some(
            (identifier) =>
              identifier.range[0] >= pattern.range[0] &&
              identifier.range[1] <= pattern.range[1],
          );

        const isBroadBindingPattern = (
          pattern: unknown,
          variable: Variable,
          inheritedType?: unknown,
        ): boolean => {
          if (!isAstNode(pattern)) {
            return false;
          }
          if (isIdentifierReference(pattern)) {
            const isTarget = variable.identifiers.some(
              (identifier) =>
                identifier.range[0] === pattern.range[0] &&
                identifier.range[1] === pattern.range[1],
            );
            return (
              isTarget &&
              isBroadRecordType(inheritedType ?? pattern.typeAnnotation)
            );
          }
          if (pattern.type === "AssignmentPattern") {
            return isBroadBindingPattern(pattern.left, variable, inheritedType);
          }
          if (
            pattern.type !== "ObjectPattern" ||
            !Array.isArray(pattern.properties)
          ) {
            return false;
          }
          const objectType = inheritedType ?? pattern.typeAnnotation;
          for (const property of pattern.properties) {
            if (
              !isAstNode(property) ||
              property.type !== "Property" ||
              !patternContainsVariable(property.value, variable)
            ) {
              continue;
            }
            const propertyName = staticPropertyName(property);
            if (propertyName === null) {
              return false;
            }
            return isBroadBindingPattern(
              property.value,
              variable,
              propertyType(objectType, propertyName),
            );
          }
          return false;
        };

        const enclosingBindingPattern = (identifier: unknown): unknown => {
          let current = identifier;
          while (isAstNode(current) && isAstNode(current.parent)) {
            const parent = current.parent;
            if (
              parent.type !== "AssignmentPattern" &&
              parent.type !== "ObjectPattern" &&
              parent.type !== "ArrayPattern" &&
              parent.type !== "Property" &&
              parent.type !== "RestElement"
            ) {
              break;
            }
            current = parent;
          }
          return current;
        };

        const isBroadVariable = (variable: Variable): boolean =>
          variable.defs.some((definition) =>
            isBroadBindingPattern(
              enclosingBindingPattern(definition.name),
              variable,
            ),
          );

        const variableDeclaration = (
          identifier: ESTree.IdentifierReference,
        ): ESTree.VariableDeclarator | null => {
          const definition =
            resolveVariable(identifier)?.defs.find(isVariableDefinition);
          return definition?.node ?? null;
        };

        const isStableAlias = (declaration: ESTree.VariableDeclarator) =>
          declaration.parent?.type === "VariableDeclaration" &&
          declaration.parent.kind === "const";

        const broadSource = (
          node: unknown,
          seen = new Set<Variable>(),
        ): Variable | null => {
          const expression = unwrapExpression(node);
          if (!isAstNode(expression)) {
            return null;
          }

          if (isIdentifierReference(expression)) {
            const variable = resolveVariable(expression);
            if (variable === null || seen.has(variable)) {
              return null;
            }
            seen.add(variable);

            if (isBroadVariable(variable)) {
              return variable;
            }

            const declaration = variableDeclaration(expression);
            if (declaration === null) {
              return null;
            }
            if (!isStableAlias(declaration)) {
              return null;
            }
            return broadSource(declaration.init, seen);
          }

          if (isObjectExpression(expression)) {
            for (const property of expression.properties) {
              if (property.type !== "SpreadElement") {
                continue;
              }
              const source = broadSource(property.argument, seen);
              if (source !== null) {
                return source;
              }
            }
          }

          return null;
        };

        return {
          before() {
            namedTypeAnnotations.clear();
            setCalls.length = 0;
            reported.clear();
          },
          TSTypeAliasDeclaration(node) {
            if (isIdentifierReference(node.id)) {
              const variable = resolveVariable(node.id);
              if (variable !== null) {
                namedTypeAnnotations.set(variable, node);
              }
            }
          },
          CallExpression(node) {
            if (isDrizzleUpdateSetCall(node)) {
              setCalls.push(node);
            }
          },
          "Program:exit"() {
            for (const call of setCalls) {
              const argument = call.arguments.at(0);
              const source = broadSource(argument);
              if (source === null || reported.has(source)) {
                continue;
              }
              reported.add(source);
              context.report({
                node: argument ?? call,
                messageId: "untypedUpdate",
              });
            }
          },
        };
      },
    },
  },
});
