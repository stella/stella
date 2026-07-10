// Require `useShallow` around Zustand selectors that return a fresh
// object/array literal.
//
// `useXStore((s) => ({ a: s.a, b: s.b }))` allocates a brand-new object on
// every store read. Zustand compares selector results with `Object.is`, so
// the identity change fails equality on every render even when `a`/`b` did
// not change. Under Zustand v5 (built on `useSyncExternalStore`), a selector
// that never stabilizes trips React's "The result of getSnapshot should be
// cached" warning and can escalate into "Maximum update depth exceeded" as
// the store notifies subscribers in a loop.
//
// Safe patterns (not flagged):
//   - `useXStore((s) => s.field)` — selecting an identifier/member/call/
//     primitive.
//   - `useXStore(useShallow((s) => ({ ... })))` — `useShallow` diffs the
//     result shallowly instead of by reference.
//   - `useXStore()` — no selector argument.
//
// Flagged patterns:
//   - `useXStore((s) => ({ ... }))` / `useXStore((s) => [...])` — implicit
//     arrow body returning an object/array literal.
//   - `useXStore((s) => { ...; return { ... }; })` — any `return` in the
//     selector body producing an object/array literal.
//   - `useStore(store, (s) => ({ ... }))` — the bare zustand `useStore`
//     two-argument form, selector in argument position 1.

import { getImportedName, isIdentifier, unwrapExpression } from "./utils.ts";

const STORE_HOOK_NAME = /^use\w*Store$/u;
const BARE_STORE_HOOK_NAME = "useStore";
const USE_SHALLOW_MODULES = new Set([
  "zustand/react/shallow",
  "zustand/shallow",
]);

const isInlineFunction = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression";

const isFreshReferenceLiteral = (node) => {
  const unwrapped = unwrapExpression(node);
  return (
    unwrapped?.type === "ObjectExpression" ||
    unwrapped?.type === "ArrayExpression"
  );
};

// Collect the `argument` of every `return` reachable from `node` without
// crossing into a nested function's body (a `return` inside a callback
// passed to the selector is not a return of the selector itself).
const collectReturnArguments = (node, results) => {
  if (!node || typeof node !== "object") {
    return;
  }

  switch (node.type) {
    case "BlockStatement": {
      for (const statement of node.body) {
        collectReturnArguments(statement, results);
      }
      return;
    }
    case "IfStatement": {
      collectReturnArguments(node.consequent, results);
      collectReturnArguments(node.alternate, results);
      return;
    }
    case "SwitchStatement": {
      for (const switchCase of node.cases) {
        for (const statement of switchCase.consequent) {
          collectReturnArguments(statement, results);
        }
      }
      return;
    }
    case "TryStatement": {
      collectReturnArguments(node.block, results);
      if (node.handler) {
        collectReturnArguments(node.handler.body, results);
      }
      collectReturnArguments(node.finalizer, results);
      return;
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement": {
      collectReturnArguments(node.body, results);
      return;
    }
    case "ReturnStatement": {
      if (node.argument) {
        results.push(node.argument);
      }
      return;
    }
    default:
      return;
  }
};

const selectorReturnsFreshReference = (fn) => {
  if (fn.body.type !== "BlockStatement") {
    return isFreshReferenceLiteral(fn.body);
  }

  const returnArguments = [];
  collectReturnArguments(fn.body, returnArguments);
  return returnArguments.some((argument) => isFreshReferenceLiteral(argument));
};

const isUseShallowCall = (node, useShallowAliases) =>
  node?.type === "CallExpression" &&
  isIdentifier(node.callee) &&
  useShallowAliases.has(node.callee.name);

export default {
  meta: { name: "require-use-shallow" },
  rules: {
    "require-use-shallow": {
      meta: {
        type: "problem",
        messages: {
          requireUseShallow:
            "This selector returns a new object/array literal on every call, so Object.is fails every render; under Zustand v5 this trips 'The result of getSnapshot should be cached' and can loop into 'Maximum update depth exceeded'. Wrap the selector in useShallow from zustand/react/shallow, or select primitive fields individually.",
        },
        schema: [],
      },
      create(context) {
        const useShallowAliases = new Set();

        return {
          ImportDeclaration(node) {
            if (!USE_SHALLOW_MODULES.has(node.source?.value)) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                getImportedName(specifier) === "useShallow"
              ) {
                useShallowAliases.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            const callee = node.callee;
            if (!isIdentifier(callee) || !STORE_HOOK_NAME.test(callee.name)) {
              return;
            }

            const args = node.arguments;
            const selectorArg =
              callee.name === BARE_STORE_HOOK_NAME && args.length >= 2
                ? args[1]
                : args[0];

            if (selectorArg === undefined) {
              return;
            }

            if (isUseShallowCall(selectorArg, useShallowAliases)) {
              return;
            }

            if (!isInlineFunction(selectorArg)) {
              return;
            }

            if (selectorReturnsFreshReference(selectorArg)) {
              context.report({ node, messageId: "requireUseShallow" });
            }
          },
        };
      },
    },
  },
};
