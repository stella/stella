// Keep new calendar and clock logic on Temporal while allowing legacy Date at
// concrete database, protocol, and third-party library boundaries.
//
// This syntax rule follows true global Date references, globalThis.Date, stable
// aliases, typed Date parameters, and local aliases initialized from a proven
// Date. It deliberately leaves opaque return values and object properties
// alone: Oxlint plugins do not have enough type information to prove those are
// Dates without also flagging unrelated APIs with names such as `setDate`.

import {
  eslintCompatPlugin,
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

const RULE_NAME = "prefer-temporal";

const DATE_STATIC_METHODS = new Set(["now", "parse", "UTC"]);
const DATE_CALENDAR_METHODS = new Set([
  "getDate",
  "getDay",
  "getFullYear",
  "getHours",
  "getMilliseconds",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "getTimezoneOffset",
  "getUTCDate",
  "getUTCDay",
  "getUTCFullYear",
  "getUTCHours",
  "getUTCMilliseconds",
  "getUTCMinutes",
  "getUTCMonth",
  "getUTCSeconds",
  "setDate",
  "setFullYear",
  "setHours",
  "setMilliseconds",
  "setMinutes",
  "setMonth",
  "setSeconds",
  "setTime",
  "setUTCDate",
  "setUTCFullYear",
  "setUTCHours",
  "setUTCMilliseconds",
  "setUTCMinutes",
  "setUTCMonth",
  "setUTCSeconds",
]);
const IMMEDIATE_DATE_BOUNDARY_METHODS = new Set([
  "getTime",
  "toISOString",
  "toJSON",
  "toUTCString",
]);

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference => isIdentifier(node);

const bindingFromScope = (
  initialScope: Scope | null,
  name: string,
): Variable | null => {
  let scope = initialScope;
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

const propertyPathToIdentifier = (
  pattern: unknown,
  identifierName: string,
  prefix: readonly string[] = [],
): readonly string[] | null => {
  const unwrapped = unwrapExpression(pattern);
  if (isIdentifier(unwrapped, identifierName)) {
    return prefix;
  }
  if (!isAstNode(unwrapped)) {
    return null;
  }
  if (unwrapped.type === "AssignmentPattern") {
    return propertyPathToIdentifier(unwrapped.left, identifierName, prefix);
  }
  if (
    unwrapped.type !== "ObjectPattern" ||
    !Array.isArray(unwrapped.properties)
  ) {
    return null;
  }
  for (const property of unwrapped.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      continue;
    }
    const propertyName = getPropertyName(property.key);
    if (propertyName === null) {
      continue;
    }
    const path = propertyPathToIdentifier(property.value, identifierName, [
      ...prefix,
      propertyName,
    ]);
    if (path !== null) {
      return path;
    }
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          callableDate:
            "Date() reads the ambient clock and returns a locale-dependent string. Import Temporal explicitly and use Temporal.Now or a caller-owned clock.",
          calendarConstructor:
            "The multi-argument Date constructor performs legacy local-calendar arithmetic. Import Temporal explicitly and use PlainDate, PlainDateTime, or ZonedDateTime.",
          dateMethod:
            "Date.{{method}}() performs legacy calendar logic. Import Temporal explicitly and use the matching Temporal type.",
          dateStatic:
            "Date.{{method}}() is forbidden. Import Temporal explicitly and use Temporal.Now or an explicit Temporal parser/constructor.",
          globalTemporal:
            "Ambient Temporal is not portable to every supported runtime. Import Temporal explicitly from @stll/time, or from temporal-polyfill/full in a published package.",
          immediateDateMethod:
            "Calling {{method}}() directly on a new Date is not an approved Date boundary. Convert through Temporal; Date may be constructed only for database, protocol, or third-party adapters.",
        },
      },
      createOnce(context) {
        const variableFor = (
          identifier: ESTree.IdentifierReference,
        ): Variable | null =>
          bindingFromScope(
            context.sourceCode.getScope(identifier),
            identifier.name,
          );

        const isGlobalReference = (
          identifier: ESTree.IdentifierReference,
        ): boolean => {
          if (context.sourceCode.isGlobalReference(identifier)) {
            return true;
          }
          const variable = variableFor(identifier);
          return variable === null || variable.defs.length === 0;
        };

        const constantDefinition = (
          identifier: ESTree.IdentifierReference,
          visited: Set<Variable>,
        ): { init: unknown; path: readonly string[] } | null => {
          const variable = variableFor(identifier);
          if (variable === null || visited.has(variable)) {
            return null;
          }
          visited.add(variable);
          for (const definition of variable.defs) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              continue;
            }
            const path = propertyPathToIdentifier(
              definition.node.id,
              identifier.name,
            );
            if (path !== null) {
              return { init: definition.node.init, path };
            }
          }
          return null;
        };

        const isGlobalObject = (node: unknown): boolean => {
          const expression = unwrapExpression(node);
          return (
            isIdentifierReference(expression) &&
            (expression.name === "globalThis" ||
              expression.name === "global") &&
            isGlobalReference(expression)
          );
        };

        const isGlobalDate = (
          node: unknown,
          visited = new Set<Variable>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (isIdentifierReference(expression)) {
            if (expression.name === "Date" && isGlobalReference(expression)) {
              return true;
            }
            const definition = constantDefinition(expression, visited);
            return (
              definition !== null &&
              definition.path.length === 0 &&
              isGlobalDate(definition.init, visited)
            );
          }
          return (
            isAstNode(expression) &&
            expression.type === "MemberExpression" &&
            getPropertyName(expression.property) === "Date" &&
            isGlobalObject(expression.object)
          );
        };

        const dateStaticMethod = (
          node: unknown,
          visited = new Set<Variable>(),
        ): string | null => {
          const expression = unwrapExpression(node);
          if (isIdentifierReference(expression)) {
            const definition = constantDefinition(expression, visited);
            if (definition === null) {
              return null;
            }
            if (definition.path.length === 1 && isGlobalDate(definition.init)) {
              return definition.path.at(0) ?? null;
            }
            if (
              definition.path.length === 2 &&
              definition.path.at(0) === "Date" &&
              isGlobalObject(definition.init)
            ) {
              return definition.path.at(1) ?? null;
            }
            return definition.path.length === 0
              ? dateStaticMethod(definition.init, visited)
              : null;
          }
          if (
            !isAstNode(expression) ||
            expression.type !== "MemberExpression"
          ) {
            return null;
          }
          const method = getPropertyName(expression.property);
          return method !== null && isGlobalDate(expression.object)
            ? method
            : null;
        };

        const isDateType = (node: unknown): boolean => {
          const annotation =
            isAstNode(node) && node.type === "TSTypeAnnotation"
              ? node.typeAnnotation
              : node;
          if (
            isAstNode(annotation) &&
            annotation.type === "TSTypeReference" &&
            isIdentifierReference(annotation.typeName) &&
            annotation.typeName.name === "Date" &&
            isGlobalReference(annotation.typeName)
          ) {
            return true;
          }
          if (
            !isAstNode(annotation) ||
            annotation.type !== "TSUnionType" ||
            !Array.isArray(annotation.types)
          ) {
            return false;
          }
          let includesDate = false;
          for (const member of annotation.types) {
            if (isDateType(member)) {
              includesDate = true;
              continue;
            }
            if (
              !isAstNode(member) ||
              (member.type !== "TSNullKeyword" &&
                member.type !== "TSUndefinedKeyword")
            ) {
              return false;
            }
          }
          return includesDate;
        };

        const variableHasDateType = (variable: Variable): boolean =>
          variable.defs.some((definition) => {
            if (
              definition.type === "Variable" &&
              isAstNode(definition.node) &&
              definition.node.type === "VariableDeclarator"
            ) {
              return isAstNode(definition.node.id)
                ? isDateType(definition.node.id.typeAnnotation)
                : false;
            }
            if (
              definition.type !== "Parameter" ||
              !isAstNode(definition.name)
            ) {
              return false;
            }
            return isDateType(definition.name.typeAnnotation);
          });

        const isProvenDate = (
          node: unknown,
          visited = new Set<Variable>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (
            isAstNode(expression) &&
            expression.type === "NewExpression" &&
            isGlobalDate(expression.callee)
          ) {
            return true;
          }
          if (!isIdentifierReference(expression)) {
            return false;
          }
          const variable = variableFor(expression);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          visited.add(variable);
          if (variableHasDateType(variable)) {
            return true;
          }
          for (const definition of variable.defs) {
            if (
              definition.type === "Variable" &&
              isAstNode(definition.node) &&
              definition.node.type === "VariableDeclarator" &&
              isAstNode(definition.parent) &&
              definition.parent.type === "VariableDeclaration" &&
              definition.parent.kind === "const" &&
              isProvenDate(definition.node.init, visited)
            ) {
              return true;
            }
          }
          return false;
        };

        return {
          Identifier(node) {
            if (
              isIdentifierReference(node) &&
              node.name === "Temporal" &&
              context.sourceCode.isGlobalReference(node)
            ) {
              context.report({ node, messageId: "globalTemporal" });
            }
          },
          MemberExpression(node) {
            if (
              getPropertyName(node.property) === "Temporal" &&
              isGlobalObject(node.object)
            ) {
              context.report({ node, messageId: "globalTemporal" });
              return;
            }
            const staticMethod = dateStaticMethod(node);
            if (
              staticMethod !== null &&
              DATE_STATIC_METHODS.has(staticMethod)
            ) {
              context.report({
                node,
                messageId: "dateStatic",
                data: { method: staticMethod },
              });
            }
          },
          CallExpression(node) {
            if (isGlobalDate(node.callee)) {
              context.report({ node, messageId: "callableDate" });
              return;
            }

            const staticMethod = dateStaticMethod(node.callee);
            if (
              staticMethod !== null &&
              DATE_STATIC_METHODS.has(staticMethod) &&
              unwrapExpression(node.callee)?.type !== "MemberExpression"
            ) {
              context.report({
                node,
                messageId: "dateStatic",
                data: { method: staticMethod },
              });
              return;
            }

            const callee = unwrapExpression(node.callee);
            if (!isAstNode(callee) || callee.type !== "MemberExpression") {
              return;
            }
            const method = getPropertyName(callee.property);
            if (method === null) {
              return;
            }
            const receiver = unwrapExpression(callee.object);
            if (
              isAstNode(receiver) &&
              receiver.type === "NewExpression" &&
              isGlobalDate(receiver.callee) &&
              Array.isArray(receiver.arguments) &&
              receiver.arguments.length <= 1 &&
              !IMMEDIATE_DATE_BOUNDARY_METHODS.has(method)
            ) {
              context.report({
                node,
                messageId: "immediateDateMethod",
                data: { method },
              });
              return;
            }
            if (DATE_CALENDAR_METHODS.has(method) && isProvenDate(receiver)) {
              context.report({
                node,
                messageId: "dateMethod",
                data: { method },
              });
            }
          },
          NewExpression(node) {
            if (
              isGlobalDate(node.callee) &&
              Array.isArray(node.arguments) &&
              node.arguments.length > 1
            ) {
              context.report({ node, messageId: "calendarConstructor" });
            }
          },
        };
      },
    },
  },
});
