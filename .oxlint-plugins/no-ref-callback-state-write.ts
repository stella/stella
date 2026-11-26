// No React state write from a ref callback created during render.
//
// React 19 detaches and re-attaches a callback ref whenever its identity
// changes between renders: it runs the old callback's cleanup (or calls it
// with `null`), then calls the new one with the node, in the same commit. A
// ref function created during render (an inline arrow, a local function, a
// `useCallback` whose dependencies change, a `composeRefs(...)` result) gets
// a new identity on every render it is not memoized for, and uncompiled code
// (apps/desktop, packages/ui, tests, React Compiler bailouts) memoizes none.
// When that function writes state, the write re-renders, the render makes a
// new function, and React re-attaches it: a fresh value written there loops
// until "Maximum update depth exceeded", and a write from an observer it
// registers (ResizeObserver and IntersectionObserver report once right after
// `observe()`) storms at frame rate without ever tripping React's limit.
//
// Flagged: a ref function created during render that calls a `useState`
// setter or `useReducer` dispatch anywhere in its body, in the cleanup it
// returns, in a callback it hands to an observer, listener or timer, or in a
// local function it calls. A ref function is a function written in a `ref`
// (or `*Ref`) JSX attribute, a local function or `useCallback` passed there,
// a member of `composeRefs` / `mergeRefs` / `useComposedRefs`, or, inside a
// component or hook, a function bound to a `*Ref` name or put under a `ref` /
// `*Ref` key (a hook's returned `containerRef`). `(el) => setEl(el)` is
// fixed to the bare setter.
//
// Also flagged: `composeRefs(...)` / `mergeRefs(...)` evaluated during render
// (directly or in a `useMemo` factory): the composed callback is new on every
// render, so every member ref re-attaches on every commit. `useComposedRefs`
// from `@stll/ui/effects/refs` keeps it stable while its members are.
//
// Allowed: `ref={setElement}`, the one state-writing ref (a setter's
// identity never changes); a ref object; a ref from a hook or a prop; a ref
// function that writes no state (focus, registering the node in a `Map`
// held in a ref, appending a canvas). Values observed on the element come
// from `useObservedValue`, `useLayoutMeasurement`, `useElementSize` or
// `useIntersecting` (`@stll/ui/effects/dom`) given the element held by
// `ref={setElement}`; that module (packages/ui/src/effects/) is exempt by
// ownership.
//
// Known limit, shared with no-effect-state-write: a setter that arrives as a
// prop or a store action is not recognised.
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  calleeName,
  EFFECTS_OWNER_DIRECTORY,
  isStateHook,
} from "./no-effect-state-write.ts";
import {
  getPropertyName,
  isIdentifier,
  isIdentifierReference,
  repoRelativeFilename,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const FUNCTION_VALUES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"]);
/** Calls that turn their arguments into one ref callback. */
const REF_COMPOSERS = new Set(["composeRefs", "mergeRefs", "useComposedRefs"]);
/** The composers that build a new callback on every call. */
const RENDER_COMPOSERS = new Set(["composeRefs", "mergeRefs"]);
const REF_NAME = /^(?:ref|[a-z]\w*Ref)$/u;

const enclosingFunction = (node) => {
  let current = node.parent;
  while (current) {
    if (FUNCTIONS.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const functionName = (node) => {
  if (isIdentifier(node.id)) {
    return node.id.name;
  }
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && isIdentifier(parent.id)) {
    return parent.id.name;
  }
  if (parent?.type === "Property") {
    return getPropertyName(parent.key);
  }
  return null;
};

// A component (capitalised, or passed straight to `memo` / `forwardRef`) or a
// hook (`use*`): a function whose body runs during render.
const isReactOwner = (node) => {
  const name = functionName(node);
  if (name !== null) {
    return /^[A-Z]/u.test(name) || /^use[A-Z0-9]/u.test(name);
  }
  const parent = node.parent;
  return (
    parent?.type === "CallExpression" &&
    parent.arguments[0] === node &&
    COMPONENT_WRAPPERS.has(calleeName(parent.callee) ?? "")
  );
};

// The function whose run evaluates `node`, seen through `useMemo` factories,
// which run during render like the owner's body around them.
const renderEvaluatedFunction = (node) => {
  let fn = enclosingFunction(node);
  while (
    fn?.parent?.type === "CallExpression" &&
    fn.parent.arguments[0] === fn &&
    calleeName(fn.parent.callee) === "useMemo"
  ) {
    fn = enclosingFunction(fn.parent);
  }
  return fn;
};

const isInsideReactOwner = (node) => {
  let fn = enclosingFunction(node);
  while (fn) {
    if (isReactOwner(fn)) {
      return true;
    }
    fn = enclosingFunction(fn);
  }
  return false;
};

const isUseCallback = (node) =>
  node?.type === "CallExpression" && calleeName(node.callee) === "useCallback";

const isComposerCall = (node, names) =>
  node?.type === "CallExpression" && names.has(calleeName(node.callee) ?? "");

// The scope of one linted file: the state setters it declares and the
// context that resolves its identifiers.
type FileScope = { context; setters: Set<unknown> };

const singleDefinition = (scope: FileScope, identifier) => {
  const variable = resolveVariable(scope.context, identifier);
  return variable?.defs.length === 1
    ? { variable, definition: variable.defs[0] }
    : null;
};

// The local function an identifier names: a function declaration, a
// function-valued binding, or the function given to `useCallback`.
const localFunction = (scope: FileScope, identifier) => {
  if (!isIdentifierReference(identifier)) {
    return null;
  }
  const found = singleDefinition(scope, identifier);
  if (found === null || scope.setters.has(found.variable)) {
    return null;
  }
  const { definition } = found;
  if (
    definition.type === "FunctionName" &&
    FUNCTIONS.has(definition.node.type)
  ) {
    return definition.node;
  }
  if (
    definition.type !== "Variable" ||
    definition.node.type !== "VariableDeclarator"
  ) {
    return null;
  }
  const init = unwrapExpression(definition.node.init);
  if (FUNCTION_VALUES.has(init?.type)) {
    return init;
  }
  if (isUseCallback(init)) {
    const callback = unwrapExpression(init.arguments[0]);
    return FUNCTION_VALUES.has(callback?.type) ? callback : null;
  }
  return null;
};

// The initializer of a `const` an identifier names, when it is a composer.
const composerInitializer = (scope: FileScope, identifier) => {
  const definition = singleDefinition(scope, identifier)?.definition;
  const init =
    definition?.type === "Variable" &&
    definition.node.type === "VariableDeclarator"
      ? unwrapExpression(definition.node.init)
      : null;
  return isComposerCall(init, REF_COMPOSERS) ? init : null;
};

// The render-created functions a ref expression evaluates to.
const refFunctions = (scope: FileScope, expression, seen = new Set()) => {
  const node = unwrapExpression(expression);
  if (!node || seen.has(node)) {
    return [];
  }
  seen.add(node);
  const inner = (child) => refFunctions(scope, child, seen);
  if (FUNCTION_VALUES.has(node.type)) {
    return enclosingFunction(node) ? [node] : [];
  }
  switch (node.type) {
    case "ConditionalExpression":
      return [...inner(node.consequent), ...inner(node.alternate)];
    case "LogicalExpression":
      return [...inner(node.left), ...inner(node.right)];
    default:
      break;
  }
  if (isUseCallback(node)) {
    return inner(node.arguments[0]);
  }
  if (isComposerCall(node, REF_COMPOSERS)) {
    return node.arguments.flatMap(inner);
  }
  if (!isIdentifierReference(node)) {
    return [];
  }
  const local = localFunction(scope, node);
  if (local) {
    return enclosingFunction(local) ? [local] : [];
  }
  const composer = composerInitializer(scope, node);
  return composer === null ? [] : inner(composer);
};

// `(el) => setEl(el)` or `(el) => { setEl(el); }`: the setter's name.
const forwardedSetter = (scope: FileScope, fn) => {
  const [parameter] = fn.params;
  if (fn.params.length !== 1 || !isIdentifier(parameter)) {
    return null;
  }
  let call = fn.body;
  if (call.type === "BlockStatement") {
    const [statement] = call.body;
    if (call.body.length !== 1 || statement.type !== "ExpressionStatement") {
      return null;
    }
    call = statement.expression;
  }
  if (
    call?.type !== "CallExpression" ||
    call.arguments.length !== 1 ||
    !isIdentifier(call.arguments[0], parameter.name) ||
    !isIdentifierReference(call.callee) ||
    !scope.setters.has(resolveVariable(scope.context, call.callee))
  ) {
    return null;
  }
  return call.callee.name;
};

// Every function that writes state when it runs: one whose body, at any
// depth, calls a setter or a local function that does.
const stateWriters = (scope: FileScope, identifierCalls) => {
  const writers = new Set();
  const callers = new Map();
  const markWriter = (fn) => {
    for (let owner = fn; owner; owner = enclosingFunction(owner)) {
      if (writers.has(owner)) {
        return;
      }
      writers.add(owner);
      for (const caller of callers.get(owner) ?? []) {
        markWriter(caller);
      }
    }
  };
  const isSetterCall = (call) =>
    scope.setters.has(resolveVariable(scope.context, call.callee));
  for (const call of identifierCalls) {
    if (isSetterCall(call)) {
      continue;
    }
    const callee = localFunction(scope, call.callee);
    if (callee === null) {
      continue;
    }
    const list = callers.get(callee) ?? [];
    for (
      let owner = enclosingFunction(call);
      owner;
      owner = enclosingFunction(owner)
    ) {
      list.push(owner);
    }
    callers.set(callee, list);
  }
  for (const call of identifierCalls) {
    if (isSetterCall(call)) {
      markWriter(enclosingFunction(call));
    }
  }
  return writers;
};

const reportRefWrites = (scope: FileScope, refSites, writers) => {
  const reported = new Set();
  for (const site of refSites) {
    for (const fn of refFunctions(scope, site)) {
      if (reported.has(fn) || !writers.has(fn)) {
        continue;
      }
      reported.add(fn);
      const setter = forwardedSetter(scope, fn);
      if (setter === null) {
        scope.context.report({ node: fn, messageId: "refWritesState" });
      } else {
        scope.context.report({
          node: fn,
          messageId: "passSetter",
          data: { setter },
          fix: (fixer) => fixer.replaceText(fn, setter),
        });
      }
    }
  }
};

const reportRenderComposition = (context, composerCalls) => {
  for (const call of composerCalls) {
    const owner = renderEvaluatedFunction(call);
    if (owner && isReactOwner(owner)) {
      context.report({
        node: call,
        messageId: "composeInRender",
        data: { composer: calleeName(call.callee) },
      });
    }
  }
};

// The `useState` / `useReducer` setter a declarator binds, if any.
const declaredSetter = (context, node) => {
  if (
    node.id.type !== "ArrayPattern" ||
    node.init?.type !== "CallExpression" ||
    !isStateHook(context, node.init.callee)
  ) {
    return null;
  }
  const binding = node.id.elements[1];
  return isIdentifierReference(binding)
    ? resolveVariable(context, binding)
    : null;
};

const isRefName = (name) => name !== null && REF_NAME.test(name);

export default eslintCompatPlugin({
  meta: { name: "no-ref-callback-state-write" },
  rules: {
    "no-ref-callback-state-write": {
      meta: {
        type: "problem",
        fixable: "code",
        messages: {
          refWritesState:
            "A ref callback created during render must not write state: it re-attaches whenever its identity changes, and a write that re-renders makes it re-attach again. Keep the element with `ref={setElement}` and derive from it with `useObservedValue`, `useLayoutMeasurement`, `useElementSize` or `useIntersecting` from `@stll/ui/effects/dom`.",
          passSetter:
            "Pass the setter itself (`ref={{{setter}}}`): a wrapper created during render re-attaches on every render and writes the element again each time.",
          composeInRender:
            "Do not compose refs during render: `{{composer}}(...)` returns a new callback each time, so React detaches and re-attaches every member ref on every commit. Use `useComposedRefs` from `@stll/ui/effects/refs`, which stays stable while its member refs are.",
        },
        schema: [],
      },
      createOnce(context) {
        const scope: FileScope = { context, setters: new Set() };
        // Calls whose callee is a plain identifier, resolved at Program:exit
        // once every setter and local function is known.
        const identifierCalls = [];
        // Expressions that hold a ref.
        const refSites = [];
        const composerCalls = [];
        return {
          Program() {
            scope.setters.clear();
            identifierCalls.length = 0;
            refSites.length = 0;
            composerCalls.length = 0;
          },
          VariableDeclarator(node) {
            const setter = declaredSetter(context, node);
            if (setter) {
              scope.setters.add(setter);
            } else if (
              isIdentifier(node.id) &&
              isRefName(node.id.name) &&
              node.init &&
              isInsideReactOwner(node)
            ) {
              refSites.push(node.init);
            }
          },
          Property(node) {
            if (
              node.parent.type === "ObjectExpression" &&
              !node.computed &&
              isRefName(getPropertyName(node.key)) &&
              isInsideReactOwner(node)
            ) {
              refSites.push(node.value);
            }
          },
          JSXAttribute(node) {
            if (
              node.name.type === "JSXIdentifier" &&
              isRefName(node.name.name) &&
              node.value?.type === "JSXExpressionContainer"
            ) {
              refSites.push(node.value.expression);
            }
          },
          CallExpression(node) {
            if (isIdentifierReference(node.callee)) {
              identifierCalls.push(node);
            }
            if (isComposerCall(node, REF_COMPOSERS)) {
              refSites.push(node);
            }
            if (isComposerCall(node, RENDER_COMPOSERS)) {
              composerCalls.push(node);
            }
          },
          "Program:exit"() {
            if (
              repoRelativeFilename(context).startsWith(EFFECTS_OWNER_DIRECTORY)
            ) {
              return;
            }
            const writers = stateWriters(scope, identifierCalls);
            reportRefWrites(scope, refSites, writers);
            reportRenderComposition(context, composerCalls);
          },
        };
      },
    },
  },
});
