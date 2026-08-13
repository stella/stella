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
      const propertyPath = destructuredPropertyPath(declarator.id, node.name);
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

const staticComputedMemberName = (
  context: unknown,
  node: unknown,
  visitedBindings: Set<unknown>,
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (isStringLiteral(expression)) {
    return expression.value;
  }
  if (
    expression.type === "TemplateLiteral" &&
    Array.isArray(expression.expressions) &&
    expression.expressions.length === 0 &&
    Array.isArray(expression.quasis)
  ) {
    const quasi = expression.quasis.at(0);
    return isAstNode(quasi) &&
      typeof quasi.value === "object" &&
      quasi.value !== null &&
      "cooked" in quasi.value &&
      typeof quasi.value.cooked === "string"
      ? quasi.value.cooked
      : null;
  }
  if (!isIdentifier(expression)) {
    return null;
  }
  const alias = constAlias(context, expression, visitedBindings);
  return alias?.type === "value"
    ? staticComputedMemberName(context, alias.value, visitedBindings)
    : null;
};

const staticMemberName = (
  context: unknown,
  node: unknown,
  visitedBindings = new Set<unknown>(),
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || expression.type !== "MemberExpression") {
    return null;
  }
  if (expression.computed === false && isIdentifier(expression.property)) {
    return expression.property.name;
  }
  return expression.computed === true
    ? staticComputedMemberName(context, expression.property, visitedBindings)
    : null;
};

type StaticPropertyWrite = {
  conditional: boolean;
  opaque: boolean;
  position: number;
  value: unknown;
};

const bindingScopeBlock = (binding: unknown): unknown =>
  typeof binding === "object" &&
  binding !== null &&
  "scope" in binding &&
  typeof binding.scope === "object" &&
  binding.scope !== null &&
  "block" in binding.scope
    ? binding.scope.block
    : null;

const writeIsConditional = (
  identifier: unknown,
  boundary: unknown,
): boolean | null => {
  let current = identifier;
  let conditional = false;
  while (isAstNode(current)) {
    const parent = current.parent;
    if (Object.is(current, boundary) || Object.is(parent, boundary)) {
      return conditional;
    }
    if (!isAstNode(parent)) {
      return null;
    }
    if (
      (parent.type === "IfStatement" && current !== parent.test) ||
      (parent.type === "ConditionalExpression" && current !== parent.test) ||
      parent.type === "SwitchCase" ||
      (parent.type === "LogicalExpression" && current === parent.right) ||
      parent.type === "ForStatement" ||
      parent.type === "ForInStatement" ||
      parent.type === "ForOfStatement" ||
      parent.type === "WhileStatement" ||
      parent.type === "DoWhileStatement" ||
      parent.type === "CatchClause"
    ) {
      conditional = true;
    }
    if (
      parent.type === "ArrowFunctionExpression" ||
      parent.type === "FunctionExpression" ||
      parent.type === "FunctionDeclaration"
    ) {
      return null;
    }
    current = parent;
  }
  return null;
};

const enclosingZeroArgumentFunction = (node: unknown): unknown => {
  let current = node;
  while (isAstNode(current)) {
    const parent = current.parent;
    if (
      isAstNode(parent) &&
      (parent.type === "ArrowFunctionExpression" ||
        parent.type === "FunctionExpression" ||
        parent.type === "FunctionDeclaration")
    ) {
      return Array.isArray(parent.params) && parent.params.length === 0
        ? parent
        : null;
    }
    current = parent;
  }
  return null;
};

const immediateHelperCallContexts = (
  context: unknown,
  functionNode: unknown,
  boundary: unknown,
  beforePosition: number,
): Array<{ conditional: boolean; position: number }> => {
  if (
    !isAstNode(functionNode) ||
    typeof context !== "object" ||
    context === null ||
    !("sourceCode" in context) ||
    typeof context.sourceCode !== "object" ||
    context.sourceCode === null ||
    !("getScope" in context.sourceCode) ||
    typeof context.sourceCode.getScope !== "function"
  ) {
    return [];
  }
  const bindingIdentifier =
    functionNode.type === "FunctionDeclaration" && isIdentifier(functionNode.id)
      ? functionNode.id
      : isAstNode(functionNode.parent) &&
          functionNode.parent.type === "VariableDeclarator" &&
          functionNode.parent.init === functionNode &&
          isIdentifier(functionNode.parent.id)
        ? functionNode.parent.id
        : null;
  if (bindingIdentifier === null) {
    return [];
  }
  const binding = bindingFromScope(
    context.sourceCode.getScope(bindingIdentifier),
    bindingIdentifier.name,
  );
  if (
    typeof binding !== "object" ||
    binding === null ||
    !("references" in binding) ||
    !Array.isArray(binding.references)
  ) {
    return [];
  }
  const calls: Array<{ conditional: boolean; position: number }> = [];
  for (const reference of binding.references) {
    if (
      typeof reference !== "object" ||
      reference === null ||
      !("identifier" in reference) ||
      !isIdentifier(reference.identifier)
    ) {
      continue;
    }
    const call = reference.identifier.parent;
    if (
      !isAstNode(call) ||
      call.type !== "CallExpression" ||
      call.callee !== reference.identifier ||
      !Array.isArray(call.arguments) ||
      call.arguments.length !== 0 ||
      call.range[0] >= beforePosition
    ) {
      continue;
    }
    const conditional = writeIsConditional(reference.identifier, boundary);
    if (conditional !== null) {
      calls.push({ conditional, position: call.range[0] });
    }
  }
  return calls;
};

const staticPropertyWrites = (
  context: unknown,
  binding: unknown,
  propertyName: string,
  beforePosition: number,
  visitedBindings = new Set<unknown>(),
  boundary = bindingScopeBlock(binding),
): StaticPropertyWrite[] => {
  if (
    typeof binding !== "object" ||
    binding === null ||
    visitedBindings.has(binding) ||
    !("references" in binding) ||
    !Array.isArray(binding.references)
  ) {
    return [];
  }
  visitedBindings.add(binding);
  const writes: StaticPropertyWrite[] = [];
  for (const reference of binding.references) {
    if (
      typeof reference !== "object" ||
      reference === null ||
      !("identifier" in reference) ||
      !isIdentifier(reference.identifier)
    ) {
      continue;
    }
    const identifier = reference.identifier;
    const parent = identifier.parent;
    if (
      isAstNode(parent) &&
      parent.type === "MemberExpression" &&
      parent.object === identifier &&
      staticMemberName(context, parent) === propertyName
    ) {
      const write = parent.parent;
      if (
        isAstNode(write) &&
        ((write.type === "AssignmentExpression" && write.left === parent) ||
          (write.type === "UpdateExpression" && write.argument === parent) ||
          (write.type === "UnaryExpression" &&
            write.operator === "delete" &&
            write.argument === parent))
      ) {
        const directConditional =
          write.range[0] < beforePosition
            ? writeIsConditional(identifier, boundary)
            : null;
        const helperCandidate =
          directConditional === null
            ? enclosingZeroArgumentFunction(identifier)
            : null;
        const helper =
          isAstNode(helperCandidate) &&
          !Object.is(helperCandidate, boundary) &&
          !Object.is(helperCandidate.body, boundary)
            ? helperCandidate
            : null;
        const helperBody =
          isAstNode(helper) && isAstNode(helper.body) ? helper.body : null;
        const helperWriteConditional =
          helperBody === null
            ? null
            : writeIsConditional(identifier, helperBody);
        const executionContexts =
          directConditional === null
            ? helperWriteConditional === null
              ? []
              : immediateHelperCallContexts(
                  context,
                  helper,
                  boundary,
                  beforePosition,
                ).map((call) => ({
                  conditional: call.conditional || helperWriteConditional,
                  position: call.position,
                }))
            : [
                {
                  conditional: directConditional,
                  position: write.range[0],
                },
              ];
        for (const execution of executionContexts) {
          writes.push({
            conditional: execution.conditional,
            opaque:
              write.type !== "AssignmentExpression" || write.operator !== "=",
            position: execution.position,
            value: write.type === "AssignmentExpression" ? write.right : null,
          });
        }
      }
    }
    if (
      isAstNode(parent) &&
      parent.type === "VariableDeclarator" &&
      parent.init === identifier &&
      isIdentifier(parent.id) &&
      typeof context === "object" &&
      context !== null &&
      "sourceCode" in context &&
      typeof context.sourceCode === "object" &&
      context.sourceCode !== null &&
      "getScope" in context.sourceCode &&
      typeof context.sourceCode.getScope === "function"
    ) {
      const aliasBinding = bindingFromScope(
        context.sourceCode.getScope(parent.id),
        parent.id.name,
      );
      writes.push(
        ...staticPropertyWrites(
          context,
          aliasBinding,
          propertyName,
          beforePosition,
          visitedBindings,
          boundary,
        ),
      );
    }
  }
  return writes.toSorted((left, right) => left.position - right.position);
};

type StaticPropertyResolution =
  | { type: "absent" }
  | { type: "found"; value: unknown }
  | { type: "possible"; values: readonly unknown[] }
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
  beforePosition = Number.POSITIVE_INFINITY,
): StaticPropertyResolution => {
  const expression = unwrapExpression(object);
  if (expression === null) {
    return { type: "opaque" };
  }
  if (isIdentifier(expression)) {
    const binding =
      typeof context === "object" &&
      context !== null &&
      "sourceCode" in context &&
      typeof context.sourceCode === "object" &&
      context.sourceCode !== null &&
      "getScope" in context.sourceCode &&
      typeof context.sourceCode.getScope === "function"
        ? bindingFromScope(
            context.sourceCode.getScope(expression),
            expression.name,
          )
        : null;
    const propertyWrites = staticPropertyWrites(
      context,
      binding,
      propertyName,
      beforePosition,
    );
    const alias = constAlias(context, expression, visitedBindings);
    const lastUnconditionalWrite = propertyWrites.findLast(
      (write) => !write.conditional && !write.opaque,
    );
    const basePosition = lastUnconditionalWrite?.position ?? -1;
    if (
      propertyWrites.some(
        (write) => write.position > basePosition && write.opaque,
      )
    ) {
      return { type: "opaque" };
    }
    const baseResolution =
      lastUnconditionalWrite === undefined && alias?.type === "value"
        ? resolveStaticObjectProperty(
            context,
            alias.value,
            propertyName,
            visitedBindings,
            beforePosition,
          )
        : lastUnconditionalWrite === undefined
          ? { type: "opaque" as const }
          : { type: "found" as const, value: lastUnconditionalWrite.value };
    const conditionalWrites = propertyWrites.filter(
      (write) =>
        write.position > basePosition && write.conditional && !write.opaque,
    );
    if (conditionalWrites.length === 0 || baseResolution.type === "opaque") {
      return baseResolution;
    }
    const baseValues =
      baseResolution.type === "possible"
        ? baseResolution.values
        : baseResolution.type === "found"
          ? [baseResolution.value]
          : [];
    return {
      type: "possible",
      values: [...baseValues, ...conditionalWrites.map((write) => write.value)],
    };
  }
  if (expression.type === "MemberExpression") {
    const parentProperty = staticMemberName(context, expression);
    if (parentProperty === null) {
      return { type: "opaque" };
    }
    const parent = resolveStaticObjectProperty(
      context,
      expression.object,
      parentProperty,
      new Set(visitedBindings),
      beforePosition,
    );
    if (parent.type === "found") {
      return resolveStaticObjectProperty(
        context,
        parent.value,
        propertyName,
        visitedBindings,
        beforePosition,
      );
    }
    if (parent.type !== "possible") {
      return parent;
    }
    const branches = parent.values.map((value) =>
      resolveStaticObjectProperty(
        context,
        value,
        propertyName,
        new Set(visitedBindings),
        beforePosition,
      ),
    );
    if (branches.some((branch) => branch.type === "opaque")) {
      return { type: "opaque" };
    }
    return {
      type: "possible",
      values: branches.flatMap((branch) =>
        branch.type === "possible"
          ? branch.values
          : branch.type === "found"
            ? [branch.value]
            : [],
      ),
    };
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
        beforePosition,
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
  beforePosition = Number.POSITIVE_INFINITY,
): StaticPropertyResolution => {
  const propertyName = propertyPath.at(0);
  if (propertyName === undefined) {
    return { type: "found", value: object };
  }
  const resolved = resolveStaticObjectProperty(
    context,
    object,
    propertyName,
    visitedBindings,
    beforePosition,
  );
  if (resolved.type === "found") {
    return resolveStaticObjectPath(
      context,
      resolved.value,
      propertyPath.slice(1),
      visitedBindings,
      beforePosition,
    );
  }
  if (resolved.type !== "possible") {
    return resolved;
  }
  const branches = resolved.values.map((value) =>
    resolveStaticObjectPath(
      context,
      value,
      propertyPath.slice(1),
      new Set(visitedBindings),
      beforePosition,
    ),
  );
  if (branches.some((branch) => branch.type === "opaque")) {
    return { type: "opaque" };
  }
  return {
    type: "possible",
    values: branches.flatMap((branch) =>
      branch.type === "possible"
        ? branch.values
        : branch.type === "found"
          ? [branch.value]
          : [],
    ),
  };
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
      ? (alias.propertyPath.at(0) ?? null)
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
  return staticMemberName(context, expression, visitedBindings);
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
  beforePosition: number,
): CryptoObjectKind | null => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression)) {
    const importKind = cryptoImportKind(context, expression);
    if (importKind === "module" || importKind === "webcrypto") {
      return importKind;
    }
    const alias = constAlias(context, expression, visitedBindings);
    if (alias?.type === "value") {
      return cryptoObjectKind(
        context,
        alias.value,
        visitedBindings,
        beforePosition,
      );
    }
    if (
      alias?.type === "property" &&
      alias.propertyPath.length === 1 &&
      alias.propertyPath.at(0) === "webcrypto" &&
      cryptoObjectKind(
        context,
        alias.object,
        new Set(visitedBindings),
        beforePosition,
      ) === "module"
    ) {
      return "webcrypto";
    }
    return null;
  }
  if (expression?.type === "MemberExpression") {
    const propertyName = staticMemberName(context, expression);
    if (propertyName !== null) {
      const localProperty = resolveStaticObjectProperty(
        context,
        expression.object,
        propertyName,
        new Set(visitedBindings),
        beforePosition,
      );
      if (localProperty.type === "found" || localProperty.type === "possible") {
        const values =
          localProperty.type === "found"
            ? [localProperty.value]
            : localProperty.values;
        for (const value of values) {
          const localKind = cryptoObjectKind(
            context,
            value,
            new Set(visitedBindings),
            beforePosition,
          );
          if (localKind !== null) {
            return localKind;
          }
        }
      }
    }
  }
  if (
    expression?.type === "MemberExpression" &&
    staticMemberName(context, expression) === "webcrypto" &&
    cryptoObjectKind(
      context,
      expression.object,
      new Set(visitedBindings),
      beforePosition,
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
  beforePosition: number,
): string | null => {
  const objectKind = cryptoObjectKind(
    context,
    object,
    visitedBindings,
    beforePosition,
  );
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
  beforePosition: number,
): string | null => {
  const importedObjectKind = cryptoObjectKind(
    context,
    object,
    new Set(visitedBindings),
    beforePosition,
  );
  if (propertyPath.length === 1) {
    const importedKind = importedCryptoMemberKind(
      context,
      object,
      propertyPath.at(0) ?? null,
      new Set(visitedBindings),
      beforePosition,
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
    beforePosition,
  );
  if (localProperty.type === "found" || localProperty.type === "possible") {
    const values =
      localProperty.type === "found"
        ? [localProperty.value]
        : localProperty.values;
    for (const value of values) {
      const localKind = ambientCallKind(
        context,
        value,
        new Set(visitedBindings),
        beforePosition,
      );
      if (localKind !== null) {
        return localKind;
      }
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
  beforePosition = Number.POSITIVE_INFINITY,
): string | null => {
  const expression = unwrapExpression(callee);
  if (expression === null) {
    return null;
  }
  const invocationPosition =
    beforePosition === Number.POSITIVE_INFINITY
      ? expression.range[0]
      : beforePosition;
  if (cryptoImportKind(context, expression) === "randomUUID") {
    return "randomUUID() from crypto";
  }
  if (isIdentifier(expression)) {
    const alias = constAlias(context, expression, visitedBindings);
    if (alias?.type === "value") {
      return ambientCallKind(
        context,
        alias.value,
        visitedBindings,
        invocationPosition,
      );
    }
    if (alias?.type === "property") {
      return ambientPropertyPathKind(
        context,
        alias.object,
        alias.propertyPath,
        visitedBindings,
        invocationPosition,
      );
    }
  }
  if (expression.type === "ConditionalExpression") {
    return (
      ambientCallKind(
        context,
        expression.consequent,
        new Set(visitedBindings),
        invocationPosition,
      ) ??
      ambientCallKind(
        context,
        expression.alternate,
        new Set(visitedBindings),
        invocationPosition,
      )
    );
  }
  if (expression.type === "LogicalExpression") {
    return (
      ambientCallKind(
        context,
        expression.left,
        new Set(visitedBindings),
        invocationPosition,
      ) ??
      ambientCallKind(
        context,
        expression.right,
        new Set(visitedBindings),
        invocationPosition,
      )
    );
  }
  if (
    expression.type === "SequenceExpression" &&
    Array.isArray(expression.expressions)
  ) {
    return ambientCallKind(
      context,
      expression.expressions.at(-1),
      new Set(visitedBindings),
      invocationPosition,
    );
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const propertyName = staticMemberName(context, expression);
  const importedKind = importedCryptoMemberKind(
    context,
    expression.object,
    propertyName,
    new Set(visitedBindings),
    invocationPosition,
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
      invocationPosition,
    );
    if (localProperty.type === "found" || localProperty.type === "possible") {
      const values =
        localProperty.type === "found"
          ? [localProperty.value]
          : localProperty.values;
      for (const value of values) {
        const localKind = ambientCallKind(
          context,
          value,
          new Set(visitedBindings),
          invocationPosition,
        );
        if (localKind !== null) {
          return localKind;
        }
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

const isAmbientDateConstructor = (
  context: unknown,
  value: unknown,
  visitedBindings = new Set<unknown>(),
): boolean => {
  const expression = unwrapExpression(value);
  if (expression === null) {
    return false;
  }
  if (
    globalObjectName(context, expression, new Set(visitedBindings)) === "Date"
  ) {
    return true;
  }
  if (isIdentifier(expression)) {
    const alias = constAlias(context, expression, visitedBindings);
    if (alias?.type === "value") {
      return isAmbientDateConstructor(context, alias.value, visitedBindings);
    }
    if (alias?.type === "property") {
      const resolved = resolveStaticObjectPath(
        context,
        alias.object,
        alias.propertyPath,
        visitedBindings,
        expression.range[0],
      );
      const values =
        resolved.type === "found"
          ? [resolved.value]
          : resolved.type === "possible"
            ? resolved.values
            : [];
      return values.some((candidate) =>
        isAmbientDateConstructor(context, candidate, new Set(visitedBindings)),
      );
    }
    return false;
  }
  if (expression.type === "ConditionalExpression") {
    return (
      isAmbientDateConstructor(
        context,
        expression.consequent,
        new Set(visitedBindings),
      ) ||
      isAmbientDateConstructor(
        context,
        expression.alternate,
        new Set(visitedBindings),
      )
    );
  }
  if (expression.type === "LogicalExpression") {
    return (
      isAmbientDateConstructor(
        context,
        expression.left,
        new Set(visitedBindings),
      ) ||
      isAmbientDateConstructor(
        context,
        expression.right,
        new Set(visitedBindings),
      )
    );
  }
  return expression.type === "SequenceExpression" &&
    Array.isArray(expression.expressions)
    ? isAmbientDateConstructor(
        context,
        expression.expressions.at(-1),
        new Set(visitedBindings),
      )
    : false;
};

const explicitInvocationKind = (
  context: unknown,
  node: unknown,
): string | null => {
  if (
    !isAstNode(node) ||
    node.type !== "CallExpression" ||
    !Array.isArray(node.arguments)
  ) {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  if (callee?.type !== "MemberExpression") {
    return null;
  }
  const method = staticMemberName(context, callee);
  if (method === "call" || method === "apply") {
    const targetKind = ambientFunctionKind(context, callee.object);
    if (targetKind !== null) {
      return targetKind;
    }
  }
  return method === "apply" &&
    globalObjectName(context, callee.object) === "Reflect"
    ? ambientFunctionKind(context, node.arguments.at(0))
    : null;
};

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
  const method = staticMemberName(context, callee);
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
  const method = staticMemberName(context, callee);
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
  const callbackHost = globalObjectName(context, callee);
  if (
    callbackHost !== null &&
    FIRST_ARGUMENT_CALLBACK_GLOBALS.has(callbackHost)
  ) {
    return node.arguments.length > 0 ? [node.arguments.at(0)] : [];
  }
  if (callee?.type !== "MemberExpression") {
    return [];
  }
  const propertyName = staticMemberName(context, callee);
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
            const invocationKind = explicitInvocationKind(context, node);
            if (invocationKind !== null) {
              context.report({
                node,
                messageId: "ambientNondeterminism",
                data: { kind: `${invocationKind} invocation` },
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
              isAmbientDateConstructor(context, node.callee);
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
