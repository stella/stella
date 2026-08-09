// Prevent raw JSON from being asserted or annotated as a closed domain type.
//
// Third-party APIs and durable JSON can add fields without breaking callers;
// raw passthrough remains valid as `unknown` or `JsonValue`. What is unsafe is
// claiming that `response.json()` / `JSON.parse()` already satisfies a richer
// project type before a runtime parser has checked the fields the project uses.
//
// Flags in production application/package source:
//   (await response.json()) as RegistryCompany
//   response.json<RegistryCompany>()
//   JSON.parse(raw) as DocumentAst
//   const payload: RegistryCompany = JSON.parse(raw)
//
// Allows:
//   const payload: unknown = await response.json()
//   const payload: JsonValue = JSON.parse(raw)
//   v.parse(schema, await response.json())
//   v.safeParse(openSchema, JSON.parse(raw))

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree, Scope, Variable } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

const isProductionBoundaryFile = (filename: string): boolean => {
  if (/(?:^|\/)\.oxlint-plugins\/__fixtures__\//u.test(filename)) {
    return true;
  }
  if (!/(?:^|\/)(?:apps|packages)\//u.test(filename)) {
    return false;
  }
  return !(
    /(?:^|\/)e2e\//u.test(filename) ||
    /(?:^|\/)tests\//u.test(filename) ||
    /(?:^|\/)scripts\//u.test(filename) ||
    /(?:^|\/)packages\/scripts\//u.test(filename) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filename)
  );
};

const peelRuntimeExpression = (node: unknown) => {
  let current = unwrapExpression(node);
  while (
    current?.type === "AwaitExpression" ||
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSNonNullExpression"
  ) {
    current = unwrapExpression(current.argument ?? current.expression);
  }
  return current;
};

const isJsonParseMember = (node: unknown): boolean => {
  const current = peelRuntimeExpression(node);
  if (current?.type !== "MemberExpression") {
    return false;
  }
  const object = peelRuntimeExpression(current.object);
  const isJsonObject =
    isIdentifier(object, "JSON") ||
    (object?.type === "MemberExpression" &&
      getPropertyName(object.property) === "JSON" &&
      isIdentifier(peelRuntimeExpression(object.object), "globalThis"));
  return isJsonObject && getPropertyName(current.property) === "parse";
};

const isJsonParseCall = (
  node: unknown,
  jsonParseAliases: ReadonlySet<string>,
): boolean => {
  const current = peelRuntimeExpression(node);
  if (current?.type !== "CallExpression") {
    return false;
  }
  const callee = peelRuntimeExpression(current.callee);
  return (
    isJsonParseMember(callee) ||
    (isIdentifier(callee) && jsonParseAliases.has(callee.name))
  );
};

const isResponseJsonCall = (node: unknown): boolean => {
  const current = peelRuntimeExpression(node);
  if (current?.type !== "CallExpression") {
    return false;
  }
  const callee = peelRuntimeExpression(current.callee);
  return (
    callee?.type === "MemberExpression" &&
    getPropertyName(callee.property) === "json" &&
    Array.isArray(current.arguments) &&
    current.arguments.length === 0
  );
};

const unwrapTypeAnnotation = (node: unknown) => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "TSTypeAnnotation") {
    return unwrapTypeAnnotation(node.typeAnnotation);
  }
  if (node.type === "TSParenthesizedType" || node.type === "TSOptionalType") {
    return unwrapTypeAnnotation(node.typeAnnotation);
  }
  return node;
};

const isRawJsonType = (node: unknown): boolean => {
  const typeNode = unwrapTypeAnnotation(node);
  if (typeNode?.type === "TSUnknownKeyword") {
    return true;
  }
  if (typeNode?.type !== "TSTypeReference") {
    return false;
  }
  if (
    isIdentifier(typeNode.typeName, "JsonValue") ||
    isIdentifier(typeNode.typeName, "ReadonlyJsonValue")
  ) {
    return true;
  }
  if (!isIdentifier(typeNode.typeName, "Promise")) {
    return false;
  }
  const typeArguments = isAstNode(typeNode.typeArguments)
    ? typeNode.typeArguments.params
    : undefined;
  return Array.isArray(typeArguments) && isRawJsonType(typeArguments.at(0));
};

export default eslintCompatPlugin({
  meta: { name: "no-unvalidated-json-domain-cast" },
  rules: {
    "no-unvalidated-json-domain-cast": {
      meta: {
        type: "problem",
        messages: {
          unvalidatedDomain:
            "Raw JSON is not a validated domain value. Keep it as `unknown`/`JsonValue`, then parse only the consumed fields with a runtime schema (use a loose/open schema for evolving upstream payloads).",
        },
      },
      createOnce(context) {
        const jsonParseAliases = new Set<string>();
        const isRawJsonBoundary = (node: unknown): boolean =>
          isJsonParseCall(node, jsonParseAliases) || isResponseJsonCall(node);

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

        const hasClosedTypeAnnotation = (
          identifier: ESTree.IdentifierReference,
        ): boolean => {
          const variable = resolveVariable(identifier);
          return (
            variable?.defs.some(
              (definition) =>
                isAstNode(definition.name) &&
                definition.name.typeAnnotation &&
                !isRawJsonType(definition.name.typeAnnotation),
            ) ?? false
          );
        };

        const hasRawJsonTypeAnnotation = (variable: Variable): boolean =>
          variable.defs.some(
            (definition) =>
              isAstNode(definition.name) &&
              definition.name.typeAnnotation &&
              isRawJsonType(definition.name.typeAnnotation),
          );

        const isIdentifierReference = (
          node: unknown,
        ): node is ESTree.IdentifierReference => isIdentifier(node);

        const isUnvalidatedJsonValue = (
          node: unknown,
          seenVariables: ReadonlySet<Variable> = new Set(),
        ): boolean => {
          const current = peelRuntimeExpression(node);
          if (isRawJsonBoundary(current)) {
            return true;
          }
          if (current?.type === "ConditionalExpression") {
            return (
              isUnvalidatedJsonValue(current.consequent, seenVariables) ||
              isUnvalidatedJsonValue(current.alternate, seenVariables)
            );
          }
          if (current?.type === "LogicalExpression") {
            return (
              isUnvalidatedJsonValue(current.left, seenVariables) ||
              isUnvalidatedJsonValue(current.right, seenVariables)
            );
          }
          if (!isIdentifierReference(current)) {
            return false;
          }
          const variable = resolveVariable(current);
          if (
            variable === null ||
            seenVariables.has(variable) ||
            hasRawJsonTypeAnnotation(variable)
          ) {
            return false;
          }
          const nextSeenVariables = new Set(seenVariables);
          nextSeenVariables.add(variable);
          return (
            variable.defs.some(
              (definition) =>
                definition.type === "Variable" &&
                definition.node.type === "VariableDeclarator" &&
                isUnvalidatedJsonValue(definition.node.init, nextSeenVariables),
            ) ||
            variable.references.some(
              (reference) =>
                reference.isWrite() &&
                isUnvalidatedJsonValue(reference.writeExpr, nextSeenVariables),
            )
          );
        };

        const checkAssertion = (node: unknown) => {
          if (!isAstNode(node)) {
            return;
          }
          if (
            isUnvalidatedJsonValue(node.expression) &&
            !isRawJsonType(node.typeAnnotation)
          ) {
            context.report({ node, messageId: "unvalidatedDomain" });
          }
        };

        const containsRawJsonReturn = (node: unknown): boolean => {
          if (Array.isArray(node)) {
            return node.some(containsRawJsonReturn);
          }
          if (!isAstNode(node)) {
            return false;
          }
          if (
            node.type === "ArrowFunctionExpression" ||
            node.type === "FunctionDeclaration" ||
            node.type === "FunctionExpression"
          ) {
            return false;
          }
          if (node.type === "ReturnStatement") {
            return isUnvalidatedJsonValue(node.argument);
          }
          return Object.entries(node).some(
            ([key, child]) =>
              key !== "parent" &&
              key !== "loc" &&
              key !== "range" &&
              containsRawJsonReturn(child),
          );
        };

        const checkFunctionReturn = (node: unknown) => {
          if (
            !isAstNode(node) ||
            !node.returnType ||
            isRawJsonType(node.returnType)
          ) {
            return;
          }
          const body = node.body;
          const returnsRawJson =
            isUnvalidatedJsonValue(body) || containsRawJsonReturn(body);
          if (returnsRawJson) {
            context.report({ node, messageId: "unvalidatedDomain" });
          }
        };

        return {
          before() {
            jsonParseAliases.clear();
            return isProductionBoundaryFile(filenameForContext(context));
          },
          CallExpression(node) {
            const typeArgument = node.typeArguments?.params.at(0);
            if (
              typeArgument &&
              isRawJsonBoundary(node) &&
              !isRawJsonType(typeArgument)
            ) {
              context.report({ node, messageId: "unvalidatedDomain" });
            }
          },
          ArrowFunctionExpression: checkFunctionReturn,
          AssignmentExpression(node) {
            if (
              node.operator === "=" &&
              isUnvalidatedJsonValue(node.right) &&
              ((node.left.type === "Identifier" &&
                hasClosedTypeAnnotation(node.left)) ||
                node.left.type === "MemberExpression")
            ) {
              context.report({ node, messageId: "unvalidatedDomain" });
            }
          },
          FunctionDeclaration: checkFunctionReturn,
          FunctionExpression: checkFunctionReturn,
          VariableDeclarator(node) {
            if (node.id.type === "Identifier" && isJsonParseMember(node.init)) {
              jsonParseAliases.add(node.id.name);
            }
            if (
              isUnvalidatedJsonValue(node.init) &&
              node.id.typeAnnotation &&
              !isRawJsonType(node.id.typeAnnotation)
            ) {
              context.report({ node, messageId: "unvalidatedDomain" });
            }
          },
          TSAsExpression: checkAssertion,
          TSTypeAssertion: checkAssertion,
        };
      },
    },
  },
});
