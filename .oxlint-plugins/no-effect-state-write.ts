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
// Allowed: writes from a callback the effect hands to an external system (a
// subscription, an observer, a timer, a promise), which run when that system
// says so, not on every render.
//
// Owned: packages/ui/src/effects/ is the one place that writes state from
// effects (the mount latch, measured values, keyed resets); every caller
// only receives values from it, so the directory is exempt as a whole,
// never by call site.
//
// Existing findings are counted per file in
// no-effect-state-write-baseline.json and only shrink
// (scripts/effect-state-write-baseline.ts).
import { eslintCompatPlugin } from "@oxlint/plugins";

import rawBaselineCounts from "./no-effect-state-write-baseline.json" with { type: "json" };
import {
  getPropertyName,
  isIdentifier,
  isIdentifierReference,
  repoRelativeFilename,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
} from "./utils.ts";

const baselineCounts: Readonly<Record<string, number>> = rawBaselineCounts;

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
        messages: {
          effectStateWrite:
            "Do not write React state synchronously in an effect or its cleanup: the write re-renders, the render can re-run the effect, and that loop is a render storm. Derive the value during render, make the write in the event handler that causes it, or make it from the external system's own callback (a subscription, observer or timer).",
        },
        // `census: true` reports every finding, ignoring the per-file counts,
        // so scripts/effect-state-write-baseline.ts can regenerate them.
        schema: [
          {
            type: "object",
            properties: { census: { type: "boolean" } },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        const setters = new Set();
        const findings: Parameters<typeof context.report>[0][] = [];
        return {
          Program() {
            setters.clear();
            findings.length = 0;
          },
          VariableDeclarator(node) {
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
            if (
              !isIdentifierReference(node.callee) ||
              !setters.has(resolveVariable(context, node.callee))
            ) {
              return;
            }
            const owner = synchronousOwner(node);
            if (isEffectCallback(owner) || isEffectCleanup(owner)) {
              findings.push({ node, messageId: "effectStateWrite" });
            }
          },
          "Program:exit"() {
            const options: unknown = context.options[0];
            const census =
              typeof options === "object" &&
              options !== null &&
              Reflect.get(options, "census") === true;
            const file = repoRelativeFilename(context);
            if (file.startsWith(EFFECTS_OWNER_DIRECTORY)) {
              return;
            }
            const baseline = census ? 0 : (baselineCounts[file] ?? 0);
            for (const finding of findings.slice(baseline)) {
              context.report(finding);
            }
          },
        };
      },
    },
  },
});
