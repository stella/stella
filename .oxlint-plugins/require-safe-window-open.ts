// Forbid direct calls to browser window-opening primitives.
//
// A feature string such as `"noopener,noreferrer"` is optional at the call
// site and easy to omit on the next call. Route every external navigation
// through the sanctioned helper instead, so opener isolation and URL handling
// remain a single enforced boundary.
//
// Flags whenever the function is the browser global's `open`:
//   open(url)
//   window.open(url)
//   window["open"](url)
//   globalThis.open(url) / self.open(url)
//   globalThis.window.open(url) / window.top.open(url) / window.parent.open(url)
//   window.open.call(window, url) / (0, window.open)(url)
//   const { open } = window; open(url)
//   const popupHost = window; popupHost.open(url)
//   const openWindow = window.open; openWindow(url)
//
// This rule is scoped to browser surfaces in oxlint.config.ts. Locally bound
// values named `open`, `window`, `globalThis`, or `self` are unrelated bindings and
// stay allowed. Only immutable aliases with a statically proven initializer
// retain browser-global identity; mutable or dynamic values stay unreported.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Variable } from "@oxlint/plugins";

import type { ScopeContext } from "./utils.ts";
import {
  invokedCallee,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  patternKeyFor,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "require-safe-window-open";
const OPEN = "open";

// Globals that are the browser window itself.
const BROWSER_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  "globalThis",
  "self",
  "window",
]);
// Members of a window that are again a window.
const WINDOW_MEMBERS: ReadonlySet<string> = new Set([
  "opener",
  "parent",
  "self",
  "top",
  "window",
]);

// Resolve through `const` / never-reassigned bindings to the expression they
// hold, remembering visited variables so alias cycles terminate.
type Resolution = {
  context: ScopeContext;
  visited: Set<Variable>;
};

const bindingOf = (
  { context, visited }: Resolution,
  node: unknown,
): Variable | null => {
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  if (variable === null || visited.has(variable)) {
    return null;
  }
  visited.add(variable);
  return variable;
};

const isUnboundGlobal = (context: ScopeContext, node: unknown): boolean => {
  if (!isIdentifierReference(node)) {
    return false;
  }
  const variable = resolveVariable(context, node);
  return variable === null || variable.defs.length === 0;
};

// Whether `node` evaluates to the browser window: a global `window` /
// `globalThis` / `self`, a window member of one (`window.top`), or a stable
// alias of either.
const isBrowserWindow = (resolution: Resolution, node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (
    isIdentifier(expression) &&
    BROWSER_GLOBAL_NAMES.has(expression.name) &&
    isUnboundGlobal(resolution.context, expression)
  ) {
    return true;
  }
  if (expression.type === "MemberExpression") {
    const name = memberPropertyName(expression);
    return (
      name !== null &&
      WINDOW_MEMBERS.has(name) &&
      isBrowserWindow(resolution, expression.object)
    );
  }
  const variable = bindingOf(resolution, expression);
  const initializer = variable === null ? null : stableInitializer(variable);
  return initializer !== null && isBrowserWindow(resolution, initializer);
};

// The variable declarator `const { open } = window` binds `variable` in, when
// it destructures the `open` key from a browser window.
const isDestructuredOpen = (
  resolution: Resolution,
  variable: Variable,
): boolean => {
  const definition = variable.defs.at(0);
  const declarator: unknown = definition?.node;
  if (
    variable.defs.length !== 1 ||
    definition?.type !== "Variable" ||
    !isAstNode(declarator) ||
    declarator.type !== "VariableDeclarator" ||
    !isAstNode(declarator.id) ||
    declarator.id.type !== "ObjectPattern" ||
    variable.references.some(
      (reference) => reference.isWrite() && !reference.init,
    )
  ) {
    return false;
  }
  return (
    patternKeyFor(declarator.id, definition.name) === OPEN &&
    isBrowserWindow(resolution, declarator.init)
  );
};

// Whether `node` evaluates to the browser's `open` function.
const isBrowserOpen = (resolution: Resolution, node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (expression.type === "MemberExpression") {
    return (
      memberPropertyName(expression) === OPEN &&
      isBrowserWindow(resolution, expression.object)
    );
  }
  if (!isIdentifier(expression)) {
    return false;
  }
  if (
    expression.name === OPEN &&
    isUnboundGlobal(resolution.context, expression)
  ) {
    return true;
  }
  const variable = bindingOf(resolution, expression);
  if (variable === null) {
    return false;
  }
  if (isDestructuredOpen(resolution, variable)) {
    return true;
  }
  const initializer = stableInitializer(variable);
  return initializer !== null && isBrowserOpen(resolution, initializer);
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
            const call: unknown = node;
            const callee = isAstNode(call) ? invokedCallee(call) : null;
            if (!isBrowserOpen({ context, visited: new Set() }, callee)) {
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
