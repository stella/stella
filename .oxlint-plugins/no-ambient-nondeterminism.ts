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
//   randomUUID() imported from crypto or node:crypto
//   webcrypto randomness imported from crypto or node:crypto
//   globalThis.Date.now() (and the corresponding forms above)
//
// Immutable identifier aliases, object-destructured method aliases, and
// aliases of globalThis retain provenance. Static object properties and
// spreads are resolved at execution sites. Passing an ambient function to a
// statically proven built-in callback position is execution; merely storing
// the reference is not. Calls inside locally declared callback bodies are
// visited directly.
// Explicit date construction, mutable aliases, and locally shadowed bindings
// remain allowed. Alias walks track visited bindings so malformed or cyclic
// declarations terminate.
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
const CRYPTO_MODULES = new Set(["crypto", "node:crypto"]);
const ARRAY_CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
  "toSorted",
]);
const ARRAY_RESULT_METHODS = new Set([
  "concat",
  "filter",
  "flat",
  "flatMap",
  "map",
  "slice",
  "toReversed",
  "toSorted",
  "toSpliced",
  "with",
]);
const PROMISE_CALLBACK_METHODS = new Set(["catch", "finally", "then"]);
const PROMISE_STATIC_METHODS = new Set([
  "all",
  "allSettled",
  "any",
  "race",
  "reject",
  "resolve",
]);
const FIRST_ARGUMENT_CALLBACK_GLOBALS = new Set([
  "queueMicrotask",
  "setImmediate",
  "setInterval",
  "setTimeout",
]);

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

type CryptoImportKind = "module" | "randomUUID" | "webcrypto";

const cryptoImportKind = (
  context: unknown,
  node: unknown,
): CryptoImportKind | null => {
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
    !("defs" in binding) ||
    !Array.isArray(binding.defs)
  ) {
    return null;
  }
  for (const definition of binding.defs) {
    if (
      typeof definition !== "object" ||
      definition === null ||
      !("type" in definition) ||
      definition.type !== "ImportBinding" ||
      !("node" in definition) ||
      !isAstNode(definition.node) ||
      !("parent" in definition) ||
      !isAstNode(definition.parent) ||
      definition.parent.type !== "ImportDeclaration" ||
      !isAstNode(definition.parent.source) ||
      typeof definition.parent.source.value !== "string" ||
      !CRYPTO_MODULES.has(definition.parent.source.value)
    ) {
      continue;
    }
    if (
      definition.node.type === "ImportSpecifier" &&
      getImportedName(definition.node) === "randomUUID"
    ) {
      return "randomUUID";
    }
    if (
      definition.node.type === "ImportSpecifier" &&
      getImportedName(definition.node) === "webcrypto"
    ) {
      return "webcrypto";
    }
    if (
      definition.node.type === "ImportNamespaceSpecifier" ||
      definition.node.type === "ImportDefaultSpecifier"
    ) {
      return "module";
    }
  }
  return null;
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

type StaticPropertyResolution =
  | { type: "absent" }
  | { type: "found"; value: unknown }
  | { type: "opaque" };

const staticPropertyKey = (property: unknown): string | null => {
  if (!isAstNode(property) || property.type !== "Property") {
    return null;
  }
  if (property.computed === false && isIdentifier(property.key)) {
    return property.key.name;
  }
  return isStringLiteral(property.key) ? property.key.value : null;
};

const resolveStaticObjectProperty = (
  context: unknown,
  object: unknown,
  propertyName: string,
  visitedBindings: Set<unknown>,
): StaticPropertyResolution => {
  const expression = unwrapExpression(object);
  if (expression === null) {
    return { type: "opaque" };
  }
  if (isIdentifier(expression)) {
    const alias = constAlias(context, expression, visitedBindings);
    return alias?.type === "value"
      ? resolveStaticObjectProperty(
          context,
          alias.value,
          propertyName,
          visitedBindings,
        )
      : { type: "opaque" };
  }
  if (expression.type === "MemberExpression") {
    const parentProperty = staticMemberName(expression);
    if (parentProperty === null) {
      return { type: "opaque" };
    }
    const parent = resolveStaticObjectProperty(
      context,
      expression.object,
      parentProperty,
      new Set(visitedBindings),
    );
    return parent.type === "found"
      ? resolveStaticObjectProperty(
          context,
          parent.value,
          propertyName,
          visitedBindings,
        )
      : parent;
  }
  if (
    expression.type !== "ObjectExpression" ||
    !Array.isArray(expression.properties)
  ) {
    return { type: "opaque" };
  }
  for (const property of expression.properties.toReversed()) {
    if (!isAstNode(property)) {
      return { type: "opaque" };
    }
    if (property.type === "SpreadElement") {
      const spread = resolveStaticObjectProperty(
        context,
        property.argument,
        propertyName,
        new Set(visitedBindings),
      );
      if (spread.type !== "absent") {
        return spread;
      }
      continue;
    }
    if (property.type !== "Property") {
      return { type: "opaque" };
    }
    const key = staticPropertyKey(property);
    if (key === null) {
      return { type: "opaque" };
    }
    if (key === propertyName) {
      return { type: "found", value: property.value };
    }
  }
  return { type: "absent" };
};

const resolveStaticObjectPath = (
  context: unknown,
  object: unknown,
  propertyPath: readonly string[],
  visitedBindings: Set<unknown>,
): StaticPropertyResolution => {
  let current = object;
  for (const propertyName of propertyPath) {
    const resolved = resolveStaticObjectProperty(
      context,
      current,
      propertyName,
      visitedBindings,
    );
    if (resolved.type !== "found") {
      return resolved;
    }
    current = resolved.value;
  }
  return { type: "found", value: current };
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
      return expression.name === "global" ? "globalThis" : expression.name;
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

type CryptoObjectKind = "module" | "webcrypto";

const cryptoObjectKind = (
  context: unknown,
  node: unknown,
  visitedBindings: Set<unknown>,
): CryptoObjectKind | null => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression)) {
    const importKind = cryptoImportKind(context, expression);
    if (importKind === "module" || importKind === "webcrypto") {
      return importKind;
    }
    const alias = constAlias(context, expression, visitedBindings);
    if (alias?.type === "value") {
      return cryptoObjectKind(context, alias.value, visitedBindings);
    }
    if (
      alias?.type === "property" &&
      alias.propertyPath.length === 1 &&
      alias.propertyPath.at(0) === "webcrypto" &&
      cryptoObjectKind(
        context,
        alias.object,
        new Set(visitedBindings),
      ) === "module"
    ) {
      return "webcrypto";
    }
    return null;
  }
  if (
    expression?.type === "MemberExpression" &&
    staticMemberName(expression) === "webcrypto" &&
    cryptoObjectKind(
      context,
      expression.object,
      new Set(visitedBindings),
    ) === "module"
  ) {
    return "webcrypto";
  }
  return null;
};

const importedCryptoMemberKind = (
  context: unknown,
  object: unknown,
  propertyName: string | null,
  visitedBindings: Set<unknown>,
): string | null => {
  const objectKind = cryptoObjectKind(context, object, visitedBindings);
  if (objectKind === "module" && propertyName === "randomUUID") {
    return "randomUUID() from crypto";
  }
  if (
    objectKind === "webcrypto" &&
    (propertyName === "randomUUID" || propertyName === "getRandomValues")
  ) {
    return `webcrypto.${propertyName}() from crypto`;
  }
  return null;
};

const ambientPropertyPathKind = (
  context: unknown,
  object: unknown,
  propertyPath: readonly string[],
  visitedBindings: Set<unknown>,
): string | null => {
  const importedObjectKind = cryptoObjectKind(
    context,
    object,
    new Set(visitedBindings),
  );
  if (propertyPath.length === 1) {
    const importedKind = importedCryptoMemberKind(
      context,
      object,
      propertyPath.at(0) ?? null,
      new Set(visitedBindings),
    );
    if (importedKind !== null) {
      return importedKind;
    }
  }
  if (
    importedObjectKind === "module" &&
    propertyPath.length === 2 &&
    propertyPath.at(0) === "webcrypto" &&
    (propertyPath.at(1) === "randomUUID" ||
      propertyPath.at(1) === "getRandomValues")
  ) {
    return `webcrypto.${propertyPath.at(1)}() from crypto`;
  }
  const localProperty = resolveStaticObjectPath(
    context,
    object,
    propertyPath,
    new Set(visitedBindings),
  );
  if (localProperty.type === "found") {
    const localKind = ambientCallKind(
      context,
      localProperty.value,
      new Set(visitedBindings),
    );
    if (localKind !== null) {
      return localKind;
    }
  }
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
  if (cryptoImportKind(context, expression) === "randomUUID") {
    return "randomUUID() from crypto";
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
  const propertyName = staticMemberName(expression);
  const importedKind = importedCryptoMemberKind(
    context,
    expression.object,
    propertyName,
    new Set(visitedBindings),
  );
  if (importedKind !== null) {
    return importedKind;
  }
  if (propertyName !== null) {
    const localProperty = resolveStaticObjectProperty(
      context,
      expression.object,
      propertyName,
      new Set(visitedBindings),
    );
    if (localProperty.type === "found") {
      const localKind = ambientCallKind(
        context,
        localProperty.value,
        new Set(visitedBindings),
      );
      if (localKind !== null) {
        return localKind;
      }
    }
  }
  return ambientMemberKind(
    globalObjectName(context, expression.object, visitedBindings),
    propertyName,
  );
};

const ambientFunctionKind = (
  context: unknown,
  expression: unknown,
): string | null =>
  ambientCallKind(context, expression) ??
  (globalObjectName(context, expression) === "Date" ? "Date(...)" : null);

const isProvableArray = (
  context: unknown,
  value: unknown,
  visitedBindings = new Set<unknown>(),
): boolean => {
  const expression = unwrapExpression(value);
  if (expression === null) {
    return false;
  }
  if (expression.type === "ArrayExpression") {
    return true;
  }
  if (isIdentifier(expression)) {
    const alias = constAlias(context, expression, visitedBindings);
    return (
      alias?.type === "value" &&
      isProvableArray(context, alias.value, visitedBindings)
    );
  }
  if (expression.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(expression.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = staticMemberName(callee);
  if (
    (method === "from" || method === "of") &&
    globalObjectName(context, callee.object) === "Array"
  ) {
    return true;
  }
  return (
    method !== null &&
    ARRAY_RESULT_METHODS.has(method) &&
    isProvableArray(context, callee.object, visitedBindings)
  );
};

const isProvablePromise = (
  context: unknown,
  value: unknown,
  visitedBindings = new Set<unknown>(),
): boolean => {
  const expression = unwrapExpression(value);
  if (expression === null) {
    return false;
  }
  if (isIdentifier(expression)) {
    const alias = constAlias(context, expression, visitedBindings);
    return (
      alias?.type === "value" &&
      isProvablePromise(context, alias.value, visitedBindings)
    );
  }
  if (expression.type === "NewExpression") {
    return globalObjectName(context, expression.callee) === "Promise";
  }
  if (expression.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(expression.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = staticMemberName(callee);
  if (
    method !== null &&
    PROMISE_STATIC_METHODS.has(method) &&
    globalObjectName(context, callee.object) === "Promise"
  ) {
    return true;
  }
  return (
    method !== null &&
    PROMISE_CALLBACK_METHODS.has(method) &&
    isProvablePromise(context, callee.object, visitedBindings)
  );
};

const callbackArgumentsForCall = (
  context: unknown,
  node: unknown,
): readonly unknown[] => {
  if (
    !isAstNode(node) ||
    node.type !== "CallExpression" ||
    !Array.isArray(node.arguments)
  ) {
    return [];
  }
  const callee = unwrapExpression(node.callee);
  if (
    isIdentifier(callee) &&
    isGlobalReference(context, callee) &&
    FIRST_ARGUMENT_CALLBACK_GLOBALS.has(callee.name)
  ) {
    return node.arguments.length > 0 ? [node.arguments.at(0)] : [];
  }
  if (callee?.type !== "MemberExpression") {
    return [];
  }
  const propertyName = staticMemberName(callee);
  if (
    propertyName === "from" &&
    globalObjectName(context, callee.object) === "Array"
  ) {
    return node.arguments.length > 1 ? [node.arguments.at(1)] : [];
  }
  const hasProvableCallback =
    propertyName !== null &&
    ((ARRAY_CALLBACK_METHODS.has(propertyName) &&
      isProvableArray(context, callee.object)) ||
      (PROMISE_CALLBACK_METHODS.has(propertyName) &&
        isProvablePromise(context, callee.object)));
  if (!hasProvableCallback || node.arguments.length === 0) {
    return [];
  }
  return propertyName === "then" && node.arguments.length > 1
    ? [node.arguments.at(0), node.arguments.at(1)]
    : [node.arguments.at(0)];
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
              return;
            }
            for (const callback of callbackArgumentsForCall(context, node)) {
              const callbackKind = ambientFunctionKind(context, callback);
              if (callbackKind === null || !isAstNode(callback)) {
                continue;
              }
              context.report({
                node: callback,
                messageId: "ambientNondeterminism",
                data: { kind: `${callbackKind} callback` },
              });
            }
          },
          NewExpression(node) {
            const isAmbientDate =
              Array.isArray(node.arguments) &&
              node.arguments.length === 0 &&
              globalObjectName(context, node.callee) === "Date";
            if (isAmbientDate) {
              context.report({
                node,
                messageId: "ambientNondeterminism",
                data: { kind: "new Date()" },
              });
              return;
            }
            if (
              !Array.isArray(node.arguments) ||
              node.arguments.length === 0 ||
              globalObjectName(context, node.callee) !== "Promise"
            ) {
              return;
            }
            const callback = node.arguments.at(0);
            const callbackKind = ambientFunctionKind(context, callback);
            if (callbackKind !== null && isAstNode(callback)) {
              context.report({
                node: callback,
                messageId: "ambientNondeterminism",
                data: { kind: `${callbackKind} callback` },
              });
            }
          },
        };
      },
    },
  },
});
