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
// Explicit date construction and locally shadowed bindings remain allowed.
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

const globalObjectName = (context: unknown, node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (isIdentifier(expression)) {
    return isGlobalReference(context, expression) ? expression.name : null;
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const host = unwrapExpression(expression.object);
  if (!isIdentifier(host, "globalThis") || !isGlobalReference(context, host)) {
    return null;
  }
  return staticMemberName(expression);
};

const ambientCallKind = (context: unknown, callee: unknown): string | null => {
  const expression = unwrapExpression(callee);
  if (expression === null) {
    return null;
  }
  if (isNodeCryptoRandomUuid(context, expression)) {
    return "randomUUID() from node:crypto";
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const property = staticMemberName(expression);
  const object = globalObjectName(context, expression.object);
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
