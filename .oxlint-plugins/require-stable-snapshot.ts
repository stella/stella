// Require a cached reference from `useSyncExternalStore`'s snapshot
// arguments.
//
// `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot?)` compares
// successive `getSnapshot()` results with `Object.is` to decide whether to
// re-render. An inline `getSnapshot`/`getServerSnapshot` that builds a new
// object, array, or derived collection on every call never satisfies that
// comparison: React warns "The result of getSnapshot should be cached" and,
// because every render calls the store again to check for updates, the
// subscription can loop into "Maximum update depth exceeded".
//
// Safe patterns (not flagged):
//   - A named function / identifier / member expression passed as
//     `getSnapshot` (`useSyncExternalStore(subscribe, getSnapshot, ...)`) —
//     the rule cannot see inside it, and the standard fix is to cache the
//     value at the source, not at the call site.
//   - An inline arrow/function that returns a primitive, an existing
//     identifier, or a member expression (`() => store.cached`).
//   - An inline arrow/function that returns a call other than a known
//     fresh-reference producer (e.g. `() => store.getValue()`).
//
// Flagged patterns (argument 2 or 3 is an inline arrow/function whose
// returned value is):
//   - An object literal: `() => ({ a, b })`.
//   - An array literal: `() => [a, b]`.
//   - A call to a known fresh-reference producer: `Object.assign(...)`,
//     `Array.from(...)`, or a `.map`/`.filter`/`.slice`/`.concat`/`.flat`/
//     `.flatMap` member call.

import { getImportedName, isIdentifier, unwrapExpression } from "./utils.ts";

const REACT_MODULE = "react";
const HOOK_NAME = "useSyncExternalStore";
const SNAPSHOT_ARG_INDICES = [1, 2];

const FRESH_REFERENCE_STATIC_CALLS = new Set(["Object.assign", "Array.from"]);
const FRESH_REFERENCE_MEMBER_METHODS = new Set([
  "map",
  "filter",
  "slice",
  "concat",
  "flat",
  "flatMap",
]);

const isInlineFunction = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression";

const isFreshReferenceCall = (node) => {
  if (node.type !== "CallExpression") {
    return false;
  }

  const callee = node.callee;

  if (
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    isIdentifier(callee.object) &&
    isIdentifier(callee.property)
  ) {
    const staticName = `${callee.object.name}.${callee.property.name}`;
    if (FRESH_REFERENCE_STATIC_CALLS.has(staticName)) {
      return true;
    }
    if (FRESH_REFERENCE_MEMBER_METHODS.has(callee.property.name)) {
      return true;
    }
  }

  return false;
};

const isFreshReferenceExpression = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return false;
  }
  if (
    unwrapped.type === "ObjectExpression" ||
    unwrapped.type === "ArrayExpression"
  ) {
    return true;
  }
  return isFreshReferenceCall(unwrapped);
};

// Collect the `argument` of every `return` reachable from `node` without
// crossing into a nested function's body.
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

const snapshotReturnsFreshReference = (fn) => {
  if (fn.body.type !== "BlockStatement") {
    return isFreshReferenceExpression(fn.body);
  }

  const returnArguments = [];
  collectReturnArguments(fn.body, returnArguments);
  return returnArguments.some((argument) =>
    isFreshReferenceExpression(argument),
  );
};

export default {
  meta: { name: "require-stable-snapshot" },
  rules: {
    "require-stable-snapshot": {
      meta: {
        type: "problem",
        messages: {
          requireStableSnapshot:
            "getSnapshot/getServerSnapshot must return a cached reference, not a fresh object/array/derived collection each call. React compares results with Object.is, so an unstable snapshot trips 'The result of getSnapshot should be cached' and can loop into 'Maximum update depth exceeded'. Cache the snapshot in the store and return the same reference until the underlying data changes.",
        },
        schema: [],
      },
      create(context) {
        const useSyncExternalStoreAliases = new Set();
        const reactNamespaces = new Set();

        const isUseSyncExternalStoreCallee = (callee) => {
          if (
            isIdentifier(callee) &&
            useSyncExternalStoreAliases.has(callee.name)
          ) {
            return true;
          }
          return (
            callee.type === "MemberExpression" &&
            callee.computed === false &&
            isIdentifier(callee.object) &&
            reactNamespaces.has(callee.object.name) &&
            isIdentifier(callee.property, HOOK_NAME)
          );
        };

        return {
          ImportDeclaration(node) {
            if (node.source?.value !== REACT_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportDefaultSpecifier" ||
                specifier.type === "ImportNamespaceSpecifier"
              ) {
                reactNamespaces.add(specifier.local.name);
                continue;
              }
              if (
                specifier.type === "ImportSpecifier" &&
                getImportedName(specifier) === HOOK_NAME
              ) {
                useSyncExternalStoreAliases.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            if (!isUseSyncExternalStoreCallee(node.callee)) {
              return;
            }

            for (const index of SNAPSHOT_ARG_INDICES) {
              const arg = node.arguments[index];
              if (!isInlineFunction(arg)) {
                continue;
              }
              if (snapshotReturnsFreshReference(arg)) {
                context.report({ node, messageId: "requireStableSnapshot" });
                return;
              }
            }
          },
        };
      },
    },
  },
};
