// Require queryFn to thread TanStack Query's abort `signal` into any
// fetch()/Eden api.* call it makes directly.
//
// TanStack Query passes an AbortSignal to every queryFn via the first
// argument (`{ signal, ... }`). A queryFn that ignores it never cancels: a
// superseded call (route navigation, query-key change, a debounced refetch)
// keeps running, and its response can still resolve and land in the cache
// after a fresher call already won — the classic out-of-order-response race.
//
// Detection is intentionally lexical and scoped to the queryFn's own
// function body; it does not follow calls into helper functions or into
// nested closures defined inside the queryFn (e.g. a `.then(...)` callback).
// Flags a `queryFn` property when:
//   - It sits inside an object that also has a `queryKey` property (covers
//     `useQuery({...})`, `useInfiniteQuery({...})`, `queryOptions({...})`,
//     `infiniteQueryOptions({...})`, and factory functions that return one
//     of those), and
//   - Its value is an inline function whose body contains a *direct*
//     `fetch(...)` call or an Eden `api.*` call chain (`api.foo.bar.get(...)`,
//     rooted at the `api` client from `@/lib/api`), and
//   - Its first parameter does not destructure `signal`.
//
// Flags:
//   queryFn: async () => { return await fetch(url); }
//   queryFn: async () => { const r = await api.things.get(); return r.data; }
//   queryFn: async ({ pageParam }) => await api.things.get({ query: { pageParam } })
//
// Allows:
//   queryFn: async ({ signal }) => await fetch(url, { signal })
//   queryFn: async ({ signal }) => await api.things.get({ fetch: { signal } })
//   queryFn: fetchThing               // identifier reference — not inspected;
//                                      // audit the helper's own signature by hand
//   queryFn: async () => await loadFromWorker() // no direct fetch/api call
//   { queryFn: async () => await fetch(url) }   // no sibling `queryKey` —
//                                                // not a query-options object
//
// A queryFn that only calls a same-file or imported helper is not flagged
// even if that helper itself drops the signal — verifying transitively would
// require whole-program call-graph analysis, which this rule deliberately
// avoids to stay fast and low-noise. Audit new helpers by hand: give them a
// `{ signal }: { signal: AbortSignal }` parameter and thread it into
// `fetch`/Eden calls the same way the queryFn case does.
//
// Escape hatch: `// SAFETY:` + `// oxlint-disable-next-line
// require-query-signal/require-query-signal` when the call genuinely cannot
// race (e.g. a one-shot dev-only probe) or the signal already reaches the
// call through an opaque context identifier instead of a destructure.

import { getPropertyName, isIdentifier } from "./utils.ts";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

const isFunctionNode = (node) => FUNCTION_TYPES.has(node?.type);

// Climb `.parent` links until the nearest enclosing function is found. Used
// both to find the function that "owns" a fetch/api call (so calls inside a
// nested closure are not attributed to the outer queryFn) and to walk from
// that function back up to the `queryFn` property that defines it.
const nearestEnclosingFunction = (node) => {
  let current = node.parent;
  while (current) {
    if (isFunctionNode(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const skipWrapperAncestors = (node) => {
  let current = node;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression"
  ) {
    current = current.parent;
  }
  return current;
};

// True when `fn` is the direct value of a `queryFn` property inside an
// object literal that also declares a `queryKey` property.
const isQueryFnFunction = (fn) => {
  const property = skipWrapperAncestors(fn.parent);
  if (property?.type !== "Property") {
    return false;
  }
  if (getPropertyName(property.key) !== "queryFn") {
    return false;
  }
  const objectExpression = property.parent;
  if (objectExpression?.type !== "ObjectExpression") {
    return false;
  }
  return objectExpression.properties.some(
    (sibling) =>
      sibling?.type === "Property" &&
      getPropertyName(sibling.key) === "queryKey",
  );
};

// TanStack Query always invokes queryFn with one context argument; the
// signal is threaded by destructuring it from that first parameter.
const hasSignalParam = (fn) => {
  const firstParam = fn.params?.at(0);
  if (firstParam?.type !== "ObjectPattern") {
    return false;
  }
  return firstParam.properties.some(
    (property) =>
      property?.type === "Property" &&
      getPropertyName(property.key) === "signal",
  );
};

const isFetchCallee = (callee) => {
  if (isIdentifier(callee, "fetch")) {
    return true;
  }
  if (callee?.type !== "MemberExpression" || callee.computed !== false) {
    return false;
  }
  if (!isIdentifier(callee.property, "fetch")) {
    return false;
  }
  return (
    isIdentifier(callee.object, "globalThis") ||
    isIdentifier(callee.object, "window") ||
    isIdentifier(callee.object, "self")
  );
};

// Resolve the identifier a member/call chain is rooted at, e.g.
// `api.foo({...}).bar.get` -> the `api` Identifier node.
const rootIdentifier = (node) => {
  if (!node || typeof node.type !== "string") {
    return null;
  }
  if (node.type === "Identifier") {
    return node;
  }
  if (node.type === "MemberExpression") {
    return rootIdentifier(node.object);
  }
  if (node.type === "CallExpression") {
    return rootIdentifier(node.callee);
  }
  return null;
};

// Eden route chains call intermediate path-parameter segments as functions
// too (`api.workspaces({ workspaceId }).reports(...)`); only the trailing
// HTTP-verb call actually hits the network, so restrict to that to avoid
// double-reporting the same chain once per segment.
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head"]);

// The Eden client is always imported as `api` from `@/lib/api` (see
// CLAUDE.md). A call chain rooted at that identifier and ending in an HTTP
// verb hits the network.
const isEdenApiCallee = (callee) => {
  if (callee?.type !== "MemberExpression" || callee.computed !== false) {
    return false;
  }
  if (!HTTP_VERBS.has(getPropertyName(callee.property))) {
    return false;
  }
  return rootIdentifier(callee.object)?.name === "api";
};

export default {
  meta: { name: "require-query-signal" },
  rules: {
    "require-query-signal": {
      meta: {
        type: "problem",
        messages: {
          missingQuerySignal:
            "queryFn makes a network call without threading TanStack Query's " +
            "abort signal: destructure `signal` from the queryFn argument and " +
            "pass it through (`fetch(url, { signal })` or Eden's " +
            "`{ fetch: { signal } }`), or a superseded call can still resolve " +
            "and apply stale data after a newer one wins.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (!isFetchCallee(callee) && !isEdenApiCallee(callee)) {
              return;
            }

            const owner = nearestEnclosingFunction(node);
            if (!owner || !isQueryFnFunction(owner) || hasSignalParam(owner)) {
              return;
            }

            context.report({ node, messageId: "missingQuerySignal" });
          },
        };
      },
    },
  },
};
