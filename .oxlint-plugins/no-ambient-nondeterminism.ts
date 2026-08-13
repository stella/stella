// Keep deterministic backend logic independent of ambient time and randomness.
//
// Pure policy, normalization, codec, and classification modules must receive
// time and entropy from their caller. This keeps retries and tests replayable
// and prevents one operation from observing several unrelated wall-clock
// instants.
//
// Flags true global references only:
//   Date.now()
//   Date(...)
//   new Date()
//   Math.random()
//   crypto.randomUUID()
//   crypto.getRandomValues(...)
//   Bun.randomUUIDv7()
//   performance.now()
//   randomUUID() imported from node:crypto
//   globalThis.Date.now() (and the corresponding forms above)
//
// Immutable identifier aliases, object-destructured method aliases, and
// aliases of globalThis retain provenance. Explicit date construction,
// mutable aliases, and locally shadowed bindings remain allowed. Alias walks
// track visited bindings so malformed or cyclic declarations terminate.
// Adapted from https://github.com/typeonce-dev/ai-automation

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportedName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-ambient-nondeterminism";

const bindingFromScope = (initialScope: unknown, name: string): unknown => {
  let scope = initialScope;
  while (typeof scope === "object" && scope !== null) {
    if (
      "set" in scope &&
      typeof scope.set === "object" &&
      scope.set !== null &&
      "get" in scope.set &&
      typeof scope.set.get === "function"
    ) {
      const binding = scope.set.get(name);
      if (binding !== undefined) {
        return binding;
      }
    }
    scope = "upper" in scope ? scope.upper : null;
  }
  return null;
};

const bindingHasDefinitions = (binding: unknown): boolean =>
  typeof binding === "object" &&
  binding !== null &&
  "defs" in binding &&
  Array.isArray(binding.defs) &&
  binding.defs.length > 0;

type ConstAlias =
  | { type: "property"; object: unknown; propertyPath: readonly string[] }
  | { type: "value"; value: unknown };

const destructuredPropertyPath = (
  pattern: unknown,
  bindingName: string,
  prefix: readonly string[] = [],
): readonly string[] | null => {
  const unwrapped =
    isAstNode(pattern) && pattern.type === "AssignmentPattern"
      ? unwrapExpression(pattern.left)
      : unwrapExpression(pattern);
  if (isIdentifier(unwrapped, bindingName)) {
    return prefix;
  }
  if (
    !isAstNode(unwrapped) ||
    unwrapped.type !== "ObjectPattern" ||
    !Array.isArray(unwrapped.properties)
  ) {
    return null;
  }
  for (const property of unwrapped.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      continue;
    }
    const propertyName =
      property.computed === false
        ? isIdentifier(property.key)
          ? property.key.name
          : isStringLiteral(property.key)
            ? property.key.value
            : null
        : isStringLiteral(property.key)
          ? property.key.value
          : null;
    if (propertyName === null) {
      continue;
    }
    const path = destructuredPropertyPath(property.value, bindingName, [
      ...prefix,
      propertyName,
    ]);
    if (path !== null) {
      return path;
    }
  }
  return null;
};

const constAlias = (
  context: unknown,
  node: unknown,
  visitedBindings: Set<unknown>,
): ConstAlias | null => {
  if (
    !isIdentifier(node) ||
    typeof context !== "object" ||
    context === null ||
    !("sourceCode" in context) ||
    typeof context.sourceCode !== "object" ||
    context.sourceCode === null ||
    !("getScope" in context.sourceCode) ||
    typeof context.sourceCode.getScope !== "function"
  ) {
    return null;
  }

  const binding = bindingFromScope(
    context.sourceCode.getScope(node),
    node.name,
  );
  if (
    typeof binding !== "object" ||
    binding === null ||
    visitedBindings.has(binding) ||
    !("defs" in binding) ||
    !Array.isArray(binding.defs)
  ) {
    return null;
  }
  visitedBindings.add(binding);

  for (const definition of binding.defs) {
    if (
      typeof definition === "object" &&
      definition !== null &&
      "type" in definition &&
      definition.type === "Variable" &&
      "node" in definition &&
      isAstNode(definition.node) &&
      definition.node.type === "VariableDeclarator" &&
      "parent" in definition &&
      isAstNode(definition.parent) &&
      definition.parent.type === "VariableDeclaration" &&
      definition.parent.kind === "const"
    ) {
      const declarator = definition.node;
      if (isIdentifier(declarator.id, node.name)) {
        return { type: "value", value: declarator.init };
      }
      if (
        !isAstNode(declarator.id) ||
        declarator.id.type !== "ObjectPattern" ||
        !Array.isArray(declarator.id.properties)
      ) {
        continue;
      }
      const propertyPath = destructuredPropertyPath(
        declarator.id,
        node.name,
      );
      if (propertyPath !== null && propertyPath.length > 0) {
        return {
          type: "property",
          object: declarator.init,
          propertyPath,
        };
      }
    }
  }
  return null;
};

const isGlobalReference = (context: unknown, node: unknown): boolean => {
  if (!isIdentifier(node)) {
    return false;
  }
  if (
    typeof context !== "object" ||
    context === null ||
    !("sourceCode" in context) ||
    typeof context.sourceCode !== "object" ||
    context.sourceCode === null
  ) {
    return false;
  }
  const sourceCode = context.sourceCode;
  if (
    "isGlobalReference" in sourceCode &&
    typeof sourceCode.isGlobalReference === "function" &&
    sourceCode.isGlobalReference(node) === true
  ) {
    return true;
  }
  if (
    !("getScope" in sourceCode) ||
    typeof sourceCode.getScope !== "function"
  ) {
    return false;
  }
  const binding = bindingFromScope(sourceCode.getScope(node), node.name);
  return binding === null || !bindingHasDefinitions(binding);
};

const isNodeCryptoRandomUuid = (context: unknown, node: unknown): boolean => {
  if (
    !isIdentifier(node) ||
    typeof context !== "object" ||
    context === null ||
    !("sourceCode" in context) ||
    typeof context.sourceCode !== "object" ||
    context.sourceCode === null ||
    !("getScope" in context.sourceCode) ||
    typeof context.sourceCode.getScope !== "function"
  ) {
    return false;
  }

  const binding = bindingFromScope(
    context.sourceCode.getScope(node),
    node.name,
  );
  return (
    typeof binding === "object" &&
    binding !== null &&
    "defs" in binding &&
    Array.isArray(binding.defs) &&
    binding.defs.some(
      (definition) =>
        typeof definition === "object" &&
        definition !== null &&
        "type" in definition &&
        definition.type === "ImportBinding" &&
        "node" in definition &&
        isAstNode(definition.node) &&
        definition.node.type === "ImportSpecifier" &&
        getImportedName(definition.node) === "randomUUID" &&
        "parent" in definition &&
        isAstNode(definition.parent) &&
        definition.parent.type === "ImportDeclaration" &&
        isAstNode(definition.parent.source) &&
        definition.parent.source.value === "node:crypto",
    )
  );
};

const staticMemberName = (node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || expression.type !== "MemberExpression") {
    return null;
  }
  if (expression.computed === false && isIdentifier(expression.property)) {
    return expression.property.name;
  }
  if (expression.computed === true && isStringLiteral(expression.property)) {
    return expression.property.value;
  }
  return null;
};

const globalObjectName = (
  context: unknown,
  node: unknown,
  visitedBindings = new Set<unknown>(),
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (isIdentifier(expression)) {
    if (isGlobalReference(context, expression)) {
      return expression.name;
    }
    const alias = constAlias(context, expression, visitedBindings);
    if (alias === null) {
      return null;
    }
    if (alias.type === "value") {
      return globalObjectName(context, alias.value, visitedBindings);
    }
    return alias.propertyPath.length === 1 &&
      globalObjectName(context, alias.object, visitedBindings) === "globalThis"
      ? alias.propertyPath.at(0) ?? null
      : null;
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  if (
    globalObjectName(context, expression.object, visitedBindings) !==
    "globalThis"
  ) {
    return null;
  }
  return staticMemberName(expression);
};

const ambientMemberKind = (
  object: string | null,
  property: string | null,
): string | null => {
  if (object === "Date" && property === "now") {
    return "Date.now()";
  }
  if (object === "Math" && property === "random") {
    return "Math.random()";
  }
  if (object === "crypto" && property === "randomUUID") {
    return "crypto.randomUUID()";
  }
  if (object === "crypto" && property === "getRandomValues") {
    return "crypto.getRandomValues()";
  }
  if (object === "Bun" && property === "randomUUIDv7") {
    return "Bun.randomUUIDv7()";
  }
  if (object === "performance" && property === "now") {
    return "performance.now()";
  }
  return null;
};

const ambientPropertyPathKind = (
  context: unknown,
  object: unknown,
  propertyPath: readonly string[],
  visitedBindings: Set<unknown>,
): string | null => {
  const objectName = globalObjectName(context, object, visitedBindings);
  const fullPath =
    objectName === "globalThis"
      ? propertyPath
      : objectName === null
        ? []
        : [objectName, ...propertyPath];
  return fullPath.length === 2
    ? ambientMemberKind(fullPath.at(0) ?? null, fullPath.at(1) ?? null)
    : null;
};

const ambientCallKind = (
  context: unknown,
  callee: unknown,
  visitedBindings = new Set<unknown>(),
): string | null => {
  const expression = unwrapExpression(callee);
  if (expression === null) {
    return null;
  }
  if (isNodeCryptoRandomUuid(context, expression)) {
    return "randomUUID() from node:crypto";
  }
  if (isIdentifier(expression)) {
    const alias = constAlias(context, expression, visitedBindings);
    if (alias?.type === "value") {
      return ambientCallKind(context, alias.value, visitedBindings);
    }
    if (alias?.type === "property") {
      return ambientPropertyPathKind(
        context,
        alias.object,
        alias.propertyPath,
        visitedBindings,
      );
    }
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  return ambientMemberKind(
    globalObjectName(context, expression.object, visitedBindings),
    staticMemberName(expression),
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          ambientNondeterminism:
            "{{kind}} reads ambient nondeterminism in deterministic backend logic. Pass caller-owned time or randomness explicitly.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const kind = ambientCallKind(context, node.callee);
            if (kind !== null) {
              context.report({
                node,
                messageId: "ambientNondeterminism",
                data: { kind },
              });
              return;
            }
            if (globalObjectName(context, node.callee) === "Date") {
              context.report({
                node,
                messageId: "ambientNondeterminism",
                data: { kind: "Date(...)" },
              });
            }
          },
          NewExpression(node) {
            if (
              !Array.isArray(node.arguments) ||
              node.arguments.length !== 0 ||
              globalObjectName(context, node.callee) !== "Date"
            ) {
              return;
            }
            context.report({
              node,
              messageId: "ambientNondeterminism",
              data: { kind: "new Date()" },
            });
          },
        };
      },
    },
  },
});
