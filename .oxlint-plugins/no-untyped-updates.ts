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
  unwrapExpression,
} from "./utils.ts";

const isBroadRecordDeclaration = (
  node: ESTree.VariableDeclarator,
): boolean => {
  if (!isIdentifier(node.id)) {
    return false;
  }

  const annotation = node.id.typeAnnotation?.typeAnnotation;
  if (
    annotation?.type !== "TSTypeReference" ||
    !isIdentifier(annotation.typeName, "Record")
  ) {
    return false;
  }

  const parameters = annotation.typeArguments?.params;
  return (
    parameters?.length === 2 &&
    parameters.at(0)?.type === "TSStringKeyword" &&
    (parameters.at(1)?.type === "TSUnknownKeyword" ||
      parameters.at(1)?.type === "TSAnyKeyword")
  );
};

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
        const broadDeclarations = new Set<ESTree.VariableDeclarator>();
        const setCalls: ESTree.CallExpression[] = [];
        const reported = new Set<ESTree.VariableDeclarator>();

        const resolveVariable = (
          identifier: ESTree.IdentifierReference,
        ): Variable | null => {
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
        ): ESTree.VariableDeclarator | null => {
          const expression = unwrapExpression(node);
          if (!isAstNode(expression)) {
            return null;
          }

          if (isIdentifier(expression)) {
            const variable = resolveVariable(expression);
            if (variable === null || seen.has(variable)) {
              return null;
            }
            seen.add(variable);

            const declaration = variableDeclaration(expression);
            if (declaration === null) {
              return null;
            }
            if (broadDeclarations.has(declaration)) {
              return declaration;
            }
            if (!isStableAlias(declaration)) {
              return null;
            }
            return broadSource(declaration.init, seen);
          }

          if (expression.type === "ObjectExpression") {
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
            broadDeclarations.clear();
            setCalls.length = 0;
            reported.clear();
          },
          VariableDeclarator(node) {
            if (isBroadRecordDeclaration(node)) {
              broadDeclarations.add(node);
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
