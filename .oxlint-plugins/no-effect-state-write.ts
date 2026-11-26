// No synchronous React state write in an effect or its cleanup.
//
// An effect that sets state re-renders its component; when the render
// changes anything the effect depends on (its dependencies, a context value,
// an element a ref callback sees), the effect runs again and writes again.
// That feedback loop is the render storm: damped ones commit tens or
// hundreds of times a second without ever reaching React's "Maximum update
// depth exceeded". The built-in `react/set-state-in-effect` sees only
// `useEffect` and `useLayoutEffect` by name, so the sanctioned wrappers
// (`useMountEffect`, `useExternalSyncEffect` from apps/web/src/hooks/
// use-effect.ts) hid every write behind them.
//
// Flagged: a `useState` setter or `useReducer` dispatch called synchronously
// in the function passed to an effect hook, or in the cleanup that function
// returns; `startTransition` and `flushSync` callbacks run synchronously and
// count as the effect's own body.
//
// Followed: a local helper the effect calls synchronously (a function
// declaration, an arrow or function bound to a const, or one wrapped in
// useCallback / useLatestCallback) that itself writes state synchronously, at
// any depth of such helpers. `const recompute = () => setCount(...)` called
// from the effect is the same write as calling the setter there. In an async
// helper only the part before its first `await` runs synchronously; a write
// after it lands once the effect has returned, like a promise callback.
//
// Allowed: writes from a callback the effect hands to an external system (a
// subscription, an observer, a timer, a promise), which run when that system
// says so, not on every render.
//
// Owned: packages/ui/src/effects/ is the one place that writes state from
// effects (the mount latch, measured values, keyed resets); every caller
// only receives values from it, so the directory is exempt as a whole,
// never by call site.
//
// Test files are outside the rule (oxlint.config.ts): tests drive React on
// purpose, and the DOM-test storm check holds them instead.
import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  getPropertyName,
  isIdentifier,
  isIdentifierReference,
  repoRelativeFilename,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
} from "./utils.ts";

/** The sanctioned effect hooks (`@stll/ui/effects`), exempt by ownership. */
export const EFFECTS_OWNER_DIRECTORY = "packages/ui/src/effects/";

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const STATE_HOOKS = new Set(["useState", "useReducer"]);
/** Effect hooks and their sanctioned wrappers, by the name they are called by. */
export const EFFECT_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useIsomorphicLayoutEffect",
  "useMountEffect",
  "useExternalSyncEffect",
  "useLayoutSyncEffect",
  "useMountLayoutEffect",
]);
/** Calls that run their callback before returning, inside the effect. */
const SYNCHRONOUS_RUNNERS = new Set(["startTransition", "flushSync"]);
// Statements and expressions an await can sit in and still run on every
// call: no branch, loop, short-circuit or nested function between it and
// the helper's top-level statement list.
const UNCONDITIONAL_PARENTS = new Set([
  "AwaitExpression",
  "AssignmentExpression",
  "ExpressionStatement",
  "ReturnStatement",
  "VariableDeclaration",
  "VariableDeclarator",
]);

// Whether `node` (an await, or a `for await` loop) runs every time `owner`
// runs: it sits in one of `owner`'s top-level statements, reached only
// through UNCONDITIONAL_PARENTS.
const suspendsUnconditionally = (node, owner) => {
  let current = node;
  while (current.parent && current.parent !== owner.body) {
    const parent = current.parent;
    // A top-level try block runs on every call too; its catch handler only
    // when something before it threw, which rarely precedes the first await.
    const tryBlock =
      parent.type === "BlockStatement" &&
      parent.parent?.type === "TryStatement" &&
      parent.parent.block === parent;
    if (tryBlock) {
      current = parent.parent;
      continue;
    }
    if (!UNCONDITIONAL_PARENTS.has(parent.type)) {
      return false;
    }
    current = parent;
  }
  return current.parent === owner.body && owner.body?.type === "BlockStatement";
};

/** Hooks that return the function they are given, or one that calls it. */
const FUNCTION_WRAPPERS = new Set(["useCallback", "useLatestCallback"]);

// The function a binding holds: `const f = () => ...`, `const f = function`,
// or `const f = useCallback(() => ..., deps)`.
const boundFunction = (init) => {
  if (FUNCTIONS.has(init?.type)) {
    return init;
  }
  if (
    init?.type === "CallExpression" &&
    FUNCTION_WRAPPERS.has(calleeName(init.callee) ?? "") &&
    FUNCTIONS.has(init.arguments[0]?.type)
  ) {
    return init.arguments[0];
  }
  return null;
};

// The name a callee is called by: `name(...)` or `object.name(...)`.
export const calleeName = (callee) =>
  isIdentifier(callee)
    ? callee.name
    : callee?.type === "MemberExpression"
      ? getPropertyName(callee.property)
      : null;

export const isStateHook = (context, callee) => {
  if (isIdentifier(callee) && STATE_HOOKS.has(callee.name)) {
    return true;
  }
  const imported = resolveImportedExpressionForEnforcement(context, callee);
  return imported?.source === "react" && STATE_HOOKS.has(imported.imported);
};

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

const isCallbackOf = (fn, names) =>
  fn?.parent?.type === "CallExpression" &&
  fn.parent.arguments[0] === fn &&
  names.has(calleeName(fn.parent.callee) ?? "");

// The function whose synchronous run a call belongs to: its enclosing
// function, seen through callbacks that run synchronously.
const synchronousOwner = (node) => {
  let fn = enclosingFunction(node);
  while (isCallbackOf(fn, SYNCHRONOUS_RUNNERS)) {
    fn = enclosingFunction(fn.parent);
  }
  return fn;
};

const isEffectCallback = (fn) => isCallbackOf(fn, EFFECT_HOOKS);

// The cleanup an effect callback returns: `return () => ...` in its body, or
// the body itself of `() => () => ...`.
const isEffectCleanup = (fn) => {
  const parent = fn?.parent;
  if (parent?.type === "ArrowFunctionExpression" && parent.body === fn) {
    return isEffectCallback(parent);
  }
  if (parent?.type === "ReturnStatement") {
    return isEffectCallback(enclosingFunction(parent));
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-effect-state-write" },
  rules: {
    "no-effect-state-write": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          effectStateWrite:
            "Do not write React state synchronously in an effect or its cleanup: the write re-renders, the render can re-run the effect, and that loop is a render storm. Derive the value during render, make the write in the event handler that causes it, or make it from the external system's own callback (a subscription, observer or timer).",
        },
      },
      createOnce(context) {
        const setters = new Set();
        const findings: Parameters<typeof context.report>[0][] = [];
        // Local helpers by binding, the functions that write state
        // synchronously, and every call of a bound helper with the function
        // whose synchronous run it belongs to.
        const helpers = new Map();
        const writers = new Set();
        const helperCalls: {
          node: ESTree.CallExpression;
          variable: unknown;
          owner: unknown;
        }[] = [];
        const directWrites: { node: unknown; owner: unknown }[] = [];
        // The start of the first `await` in each async function.
        const firstAwait = new Map();
        const afterFirstAwait = (owner, node) =>
          owner?.async === true &&
          firstAwait.has(owner) &&
          firstAwait.get(owner) <= node.range[0];
        const recordSuspension = (owner, end: number) => {
          if (!(firstAwait.get(owner) <= end)) {
            firstAwait.set(owner, end);
          }
        };
        return {
          Program() {
            setters.clear();
            findings.length = 0;
            helpers.clear();
            writers.clear();
            helperCalls.length = 0;
            firstAwait.clear();
            directWrites.length = 0;
          },
          AwaitExpression(node) {
            const owner = enclosingFunction(node);
            // The helper has suspended once this await has evaluated its
            // operand, so only code after the whole expression runs later.
            if (owner && suspendsUnconditionally(node, owner)) {
              recordSuspension(owner, node.range[1]);
            }
          },
          ForOfStatement(node) {
            const owner = enclosingFunction(node);
            if (node.await && owner && suspendsUnconditionally(node, owner)) {
              recordSuspension(owner, node.right.range[1]);
            }
          },
          FunctionDeclaration(node) {
            if (node.id && isIdentifierReference(node.id)) {
              const variable = resolveVariable(context, node.id);
              if (variable) {
                helpers.set(variable, node);
              }
            }
          },
          VariableDeclarator(node) {
            const helper =
              node.id.type === "Identifier" ? boundFunction(node.init) : null;
            if (helper && isIdentifierReference(node.id)) {
              const variable = resolveVariable(context, node.id);
              if (variable) {
                helpers.set(variable, helper);
              }
            }
            if (
              node.id.type !== "ArrayPattern" ||
              node.init?.type !== "CallExpression" ||
              !isStateHook(context, node.init.callee)
            ) {
              return;
            }
            const binding = node.id.elements[1];
            if (isIdentifierReference(binding)) {
              const variable = resolveVariable(context, binding);
              if (variable) {
                setters.add(variable);
              }
            }
          },
          CallExpression(node) {
            if (!isIdentifierReference(node.callee)) {
              return;
            }
            const variable = resolveVariable(context, node.callee);
            const owner = synchronousOwner(node);
            if (!setters.has(variable)) {
              helperCalls.push({ node, variable, owner });
              return;
            }
            // Visited in source order, but an await later in the source can
            // only follow this call, so the check waits for the exit pass.
            directWrites.push({ node, owner });
            if (isEffectCallback(owner) || isEffectCleanup(owner)) {
              findings.push({ node, messageId: "effectStateWrite" });
            }
          },
          "Program:exit"() {
            for (const { node, owner } of directWrites) {
              if (owner && !afterFirstAwait(owner, node)) {
                writers.add(owner);
              }
            }
            // A function that synchronously calls a writer writes too.
            let grew = true;
            while (grew) {
              grew = false;
              for (const { node, variable, owner } of helperCalls) {
                if (
                  owner &&
                  !writers.has(owner) &&
                  writers.has(helpers.get(variable)) &&
                  !afterFirstAwait(owner, node)
                ) {
                  writers.add(owner);
                  grew = true;
                }
              }
            }
            for (const { node, variable, owner } of helperCalls) {
              if (
                writers.has(helpers.get(variable)) &&
                (isEffectCallback(owner) || isEffectCleanup(owner))
              ) {
                findings.push({ node, messageId: "effectStateWrite" });
              }
            }
            if (
              repoRelativeFilename(context).startsWith(EFFECTS_OWNER_DIRECTORY)
            ) {
              return;
            }
            for (const finding of findings) {
              context.report(finding);
            }
          },
        };
      },
    },
  },
});
