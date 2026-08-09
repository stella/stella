// Forbid direct calls to browser window-opening primitives.
//
// A feature string such as `"noopener,noreferrer"` is optional at the call
// site and easy to omit on the next call. Route every external navigation
// through the sanctioned helper instead, so opener isolation and URL handling
// remain a single enforced boundary.
//
// Flags whenever the receiver is the browser global:
//   open(url)
//   window.open(url)
//   window["open"](url)
//   globalThis.open(url)
//   globalThis.window.open(url)
//   self.open(url)
//   const popupHost = window; popupHost.open(url)
//
// This rule is scoped to browser surfaces in oxlint.config.ts. Locally bound
// values named `open`, `window`, `globalThis`, or `self` are unrelated bindings and
// stay allowed. Only immutable aliases with a statically proven initializer
// retain browser-global identity; mutable or dynamic values stay unreported.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "require-safe-window-open";

const staticTemplateValue = (node: unknown): string | null => {
  if (
    !isAstNode(node) ||
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.expressions) ||
    node.expressions.length !== 0 ||
    !Array.isArray(node.quasis) ||
    node.quasis.length !== 1
  ) {
    return null;
  }

  const quasi = node.quasis.at(0);
  if (
    !isAstNode(quasi) ||
    quasi.type !== "TemplateElement" ||
    typeof quasi.value !== "object" ||
    quasi.value === null ||
    !("cooked" in quasi.value)
  ) {
    return null;
  }

  return typeof quasi.value.cooked === "string" ? quasi.value.cooked : null;
};

const staticMemberName = (member: unknown): string | null => {
  const unwrapped = unwrapExpression(member);
  if (!unwrapped || unwrapped.type !== "MemberExpression") {
    return null;
  }

  if (unwrapped.computed === false && isIdentifier(unwrapped.property)) {
    return unwrapped.property.name;
  }
  if (unwrapped.computed !== true) {
    return null;
  }
  if (isStringLiteral(unwrapped.property)) {
    return unwrapped.property.value;
  }
  return staticTemplateValue(unwrapped.property);
};

const memberObject = (member: unknown): unknown => {
  const unwrapped = unwrapExpression(member);
  if (!unwrapped || unwrapped.type !== "MemberExpression") {
    return null;
  }
  return unwrapped.object;
};

const sourceCodeForContext = (context: unknown): unknown => {
  if (
    typeof context !== "object" ||
    context === null ||
    !("sourceCode" in context) ||
    typeof context.sourceCode !== "object" ||
    context.sourceCode === null
  ) {
    return null;
  }
  return context.sourceCode;
};

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

type ScopeVariable = {
  defs: {
    node: unknown;
    parent: unknown;
    type: string;
  }[];
  references: {
    init?: boolean;
    isWrite?: () => boolean;
  }[];
};

const isScopeVariable = (value: unknown): value is ScopeVariable =>
  typeof value === "object" &&
  value !== null &&
  "defs" in value &&
  Array.isArray(value.defs) &&
  "references" in value &&
  Array.isArray(value.references);

const scopeVariableForReference = (
  context: unknown,
  node: unknown,
): ScopeVariable | null => {
  if (!isIdentifier(node)) {
    return null;
  }
  const sourceCode = sourceCodeForContext(context);
  if (
    typeof sourceCode !== "object" ||
    sourceCode === null ||
    !("getScope" in sourceCode) ||
    typeof sourceCode.getScope !== "function"
  ) {
    return null;
  }
  const binding = bindingFromScope(sourceCode.getScope(node), node.name);
  return isScopeVariable(binding) ? binding : null;
};

const isGlobalReference = (context: unknown, node: unknown): boolean => {
  if (!isIdentifier(node)) {
    return false;
  }

  const sourceCode = sourceCodeForContext(context);
  if (typeof sourceCode !== "object" || sourceCode === null) {
    return false;
  }

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

  // Unresolved identifiers and configured globals have no local definition.
  // A parameter/import/variable declaration has at least one definition and
  // therefore shadows the browser global for this reference.
  const binding = bindingFromScope(sourceCode.getScope(node), node.name);
  return binding === null || !bindingHasDefinitions(binding);
};

type BrowserGlobalKind = "globalThis" | "self" | "window";

const stableAliasInitializer = (
  context: unknown,
  identifier: unknown,
): unknown => {
  const variable = scopeVariableForReference(context, identifier);
  if (
    variable === null ||
    variable.references.some(
      (reference) =>
        reference.init !== true &&
        typeof reference.isWrite === "function" &&
        reference.isWrite(),
    )
  ) {
    return null;
  }

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
    return definition.node.init;
  }
  return null;
};

const browserGlobalKind = (
  context: unknown,
  node: unknown,
  visited = new Set<ScopeVariable>(),
): BrowserGlobalKind | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }

  if (isIdentifier(expression)) {
    if (
      (expression.name === "window" ||
        expression.name === "globalThis" ||
        expression.name === "self") &&
      isGlobalReference(context, expression)
    ) {
      return expression.name;
    }

    const variable = scopeVariableForReference(context, expression);
    if (variable === null || visited.has(variable)) {
      return null;
    }
    visited.add(variable);
    return browserGlobalKind(
      context,
      stableAliasInitializer(context, expression),
      visited,
    );
  }

  if (
    expression.type !== "MemberExpression" ||
    staticMemberName(expression) !== "window"
  ) {
    return null;
  }
  return browserGlobalKind(context, expression.object, visited) === null
    ? null
    : "window";
};

const isBrowserOpenCallee = (context: unknown, callee: unknown): boolean => {
  const unwrappedCallee = unwrapExpression(callee);
  if (isIdentifier(unwrappedCallee, "open")) {
    return isGlobalReference(context, unwrappedCallee);
  }
  if (
    !unwrappedCallee ||
    unwrappedCallee.type !== "MemberExpression" ||
    staticMemberName(unwrappedCallee) !== "open"
  ) {
    return false;
  }

  return browserGlobalKind(context, memberObject(unwrappedCallee)) !== null;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          requireSafeWindowOpen:
            "Do not call the browser open() primitive directly. Use the sanctioned " +
            "openIsolatedWindow() helper so opener isolation and URL handling " +
            "are enforced centrally.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (!isBrowserOpenCallee(context, node.callee)) {
              return;
            }
            context.report({
              node,
              messageId: "requireSafeWindowOpen",
            });
          },
        };
      },
    },
  },
});
