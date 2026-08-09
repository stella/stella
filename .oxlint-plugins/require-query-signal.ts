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
// function body. Besides inline functions, it resolves an identifier through
// stable same-file function declarations, const function initializers, and
// const aliases. It does not follow calls made by the queryFn into another
// helper or into nested closures defined inside it (e.g. a `.then(...)`
// callback).
// Flags a `queryFn` property when:
//   - It sits inside an object that also has a `queryKey` property (covers
//     `useQuery({...})`, `useInfiniteQuery({...})`, `queryOptions({...})`,
//     `infiniteQueryOptions({...})`, and factory functions that return one
//     of those), and
//   - Its value is an inline function or one statically resolved same-file
//     function whose body contains a *direct* browser-global `fetch(...)`
//     call or an Eden `api.*` call chain (`api.foo.bar.get(...)`, rooted at
//     the named `api` import from `@/lib/api`), and
//   - Its first parameter does not destructure `signal`.
//
// Flags:
//   queryFn: async () => { return await fetch(url); }
//   queryFn: async () => { const r = await api.things.get(); return r.data; }
//   queryFn: async ({ pageParam }) => await api.things.get({ query: { pageParam } })
//   const fetchThing = async () => await fetch(url);
//   queryFn: fetchThing
//
// Allows:
//   queryFn: async ({ signal }) => await fetch(url, { signal })
//   queryFn: async ({ signal }) => await api.things.get({ fetch: { signal } })
//   queryFn: importedFetchThing       // queryFn imports are deliberately opaque
//   queryFn: mutableFetchThing        // mutable/reassigned queryFn bindings are opaque
//   queryFn: async (fetch) => await fetch(url) // local fetch is unrelated
//   queryFn: async (api) => await api.cache.get() // local api is unrelated
//   queryFn: async () => await loadFromWorker() // no direct fetch/api call
//   { queryFn: async () => await fetch(url) }   // no sibling `queryKey` —
//                                                // not a query-options object
//
// A queryFn that only calls another same-file or imported helper is not
// flagged even if that nested helper drops the signal: verifying transitively
// would require whole-program call-graph analysis, which this rule
// deliberately avoids to stay fast and low-noise. Audit new nested helpers by
// hand: give them a `{ signal }: { signal: AbortSignal }` parameter and thread
// it into `fetch`/Eden calls the same way the queryFn case does.
//
// Escape hatch: `// SAFETY:` + `// oxlint-disable-next-line
// require-query-signal/require-query-signal` when the call genuinely cannot
// race (e.g. a one-shot dev-only probe) or the signal already reaches the
// call through an opaque context identifier instead of a destructure.

import { eslintCompatPlugin, type Ranged } from "@oxlint/plugins";

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

type Scope = {
  set: Map<string, ScopeVariable>;
  upper: Scope | null;
};

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

type NetworkCall = {
  kind: NetworkKind;
  node: Ranged;
  owner: AstNode;
};

type NetworkKind = "eden" | "fetch";

const API_MODULE = "@/lib/api";
const GLOBAL_FETCH_HOSTS = new Set(["globalThis", "self", "window"]);

const isFunctionNode = (node) => FUNCTION_TYPES.has(node?.type);

const unwrapTS = (node) => {
  let current = node;
  while (
    current &&
    (current.type === "TSNonNullExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSInstantiationExpression")
  ) {
    current = current.expression;
  }
  return current;
};

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

const isQueryFnProperty = (property) => {
  if (
    property?.type !== "Property" ||
    getPropertyName(property.key) !== "queryFn"
  ) {
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

// True when `fn` is the direct value of a `queryFn` property inside an
// object literal that also declares a `queryKey` property.
const isQueryFnFunction = (fn) => {
  const property = skipWrapperAncestors(fn.parent);
  return isQueryFnProperty(property);
};

// TanStack Query always invokes queryFn with one context argument; the
// signal is threaded by destructuring it from that first parameter.
const signalBindingName = (fn) => {
  const firstParam = fn.params?.at(0);
  if (firstParam?.type !== "ObjectPattern") {
    return null;
  }
  const signalProperty = firstParam.properties.find(
    (property) =>
      property?.type === "Property" &&
      getPropertyName(property.key) === "signal",
  );
  const value = unwrapTS(signalProperty?.value);
  if (value?.type === "Identifier") {
    return value.name;
  }
  if (value?.type === "AssignmentPattern") {
    const left = unwrapTS(value.left);
    return left?.type === "Identifier" ? left.name : null;
  }
  return null;
};

const isFetchCallee = (callee, isGlobalReference) => {
  const unwrapped = unwrapTS(callee);
  if (isIdentifier(unwrapped, "fetch")) {
    return isGlobalReference(unwrapped, "fetch");
  }
  if (unwrapped?.type !== "MemberExpression" || unwrapped.computed !== false) {
    return false;
  }
  if (!isIdentifier(unwrapped.property, "fetch")) {
    return false;
  }
  const object = unwrapTS(unwrapped.object);
  return (
    isIdentifier(object) &&
    GLOBAL_FETCH_HOSTS.has(object.name) &&
    isGlobalReference(object, object.name)
  );
};

// Resolve the identifier a member/call chain is rooted at, e.g.
// `api.foo({...}).bar.get` -> the `api` Identifier node.
const rootIdentifier = (node) => {
  const unwrapped = unwrapTS(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return null;
  }
  if (unwrapped.type === "Identifier") {
    return unwrapped;
  }
  if (unwrapped.type === "MemberExpression") {
    return rootIdentifier(unwrapped.object);
  }
  if (unwrapped.type === "CallExpression") {
    return rootIdentifier(unwrapped.callee);
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
const isEdenApiCallee = (callee, isEdenApiRoot) => {
  const unwrapped = unwrapTS(callee);
  if (unwrapped?.type !== "MemberExpression" || unwrapped.computed !== false) {
    return false;
  }
  const propertyName = getPropertyName(unwrapped.property);
  if (propertyName === null || !HTTP_VERBS.has(propertyName)) {
    return false;
  }
  return isEdenApiRoot(rootIdentifier(unwrapped.object));
};

const containsSignalIdentifier = (node, bindingName) => {
  const unwrapped = unwrapTS(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return false;
  }
  if (isIdentifier(unwrapped, bindingName)) {
    return true;
  }
  if (unwrapped.type === "MemberExpression" && !unwrapped.computed) {
    return containsSignalIdentifier(unwrapped.object, bindingName);
  }
  if (unwrapped.type === "Property" && !unwrapped.computed) {
    return containsSignalIdentifier(unwrapped.value, bindingName);
  }
  return Object.entries(unwrapped).some(([key, value]) => {
    if (key === "parent") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((item) => containsSignalIdentifier(item, bindingName));
    }
    return containsSignalIdentifier(value, bindingName);
  });
};

const getObjectPropertyValue = (node, name) => {
  const object = unwrapTS(node);
  if (object?.type !== "ObjectExpression") {
    return null;
  }
  const property = object.properties.find(
    (candidate) =>
      candidate?.type === "Property" && getPropertyName(candidate.key) === name,
  );
  return property?.value ?? null;
};

const callThreadsSignal = (node, bindingName, kind: NetworkKind) => {
  if (kind === "fetch") {
    return containsSignalIdentifier(
      getObjectPropertyValue(node.arguments.at(1), "signal"),
      bindingName,
    );
  }
  return node.arguments.some((argument) =>
    containsSignalIdentifier(
      getObjectPropertyValue(
        getObjectPropertyValue(argument, "fetch"),
        "signal",
      ),
      bindingName,
    ),
  );
};

export default eslintCompatPlugin({
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
      createOnce(context) {
        const networkCalls = new Array<NetworkCall>();
        const queryFnReferences = new Array<
          AstNode & { type: "Identifier"; name: string }
        >();

        const resolveVariable = (
          identifier: AstNode & { type: "Identifier"; name: string },
        ): ScopeVariable | null => {
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope !== null) {
            const variable = scope.set.get(identifier.name);
            if (variable !== undefined) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const isGlobalReference = (node: unknown, name: string): boolean => {
          if (!isIdentifier(node, name)) {
            return false;
          }
          const variable = resolveVariable(node);
          return variable === null || variable.defs.length === 0;
        };

        const isEdenApiRoot = (node: unknown): boolean => {
          if (!isIdentifier(node)) {
            return false;
          }
          const variable = resolveVariable(node);
          if (variable === null || variable.defs.length !== 1) {
            return false;
          }
          const definition = variable.defs.at(0);
          return (
            definition?.type === "ImportBinding" &&
            isAstNode(definition.node) &&
            getImportedName(definition.node) === "api" &&
            isAstNode(definition.parent) &&
            definition.parent.type === "ImportDeclaration" &&
            isStringLiteral(definition.parent.source) &&
            definition.parent.source.value === API_MODULE
          );
        };

        const networkKind = (callee: unknown): NetworkKind | null => {
          if (isFetchCallee(callee, isGlobalReference)) {
            return "fetch";
          }
          return isEdenApiCallee(callee, isEdenApiRoot) ? "eden" : null;
        };

        const hasReassignment = (variable: ScopeVariable): boolean =>
          variable.references.some(
            (reference) =>
              reference.init !== true && reference.isWrite?.() === true,
          );

        const resolveLocalQueryFunction = (
          identifier: AstNode & { type: "Identifier"; name: string },
          visited = new Set<ScopeVariable>(),
        ): AstNode | null => {
          const variable = resolveVariable(identifier);
          if (
            variable === null ||
            variable.defs.length !== 1 ||
            visited.has(variable) ||
            hasReassignment(variable)
          ) {
            return null;
          }
          visited.add(variable);

          const definition = variable.defs.at(0);
          if (
            definition?.type === "FunctionName" &&
            isAstNode(definition.node) &&
            definition.node.type === "FunctionDeclaration"
          ) {
            return definition.node;
          }
          if (
            definition?.type !== "Variable" ||
            !isAstNode(definition.node) ||
            definition.node.type !== "VariableDeclarator" ||
            !isIdentifier(definition.node.id, identifier.name) ||
            !isAstNode(definition.parent) ||
            definition.parent.type !== "VariableDeclaration" ||
            definition.parent.kind !== "const"
          ) {
            return null;
          }

          const initializer = unwrapTS(definition.node.init);
          if (isFunctionNode(initializer)) {
            return initializer;
          }
          return isIdentifier(initializer)
            ? resolveLocalQueryFunction(initializer, visited)
            : null;
        };

        return {
          before() {
            networkCalls.length = 0;
            queryFnReferences.length = 0;
          },
          Property(node) {
            if (!isQueryFnProperty(node)) {
              return;
            }
            const value = unwrapTS(node.value);
            if (isIdentifier(value)) {
              queryFnReferences.push(value);
            }
          },
          CallExpression(node) {
            const kind = networkKind(node.callee);
            if (kind === null) {
              return;
            }

            const owner = nearestEnclosingFunction(node);
            if (!isAstNode(owner)) {
              return;
            }

            if (!isQueryFnFunction(owner)) {
              networkCalls.push({ kind, node, owner });
              return;
            }

            const bindingName = signalBindingName(owner);
            if (
              bindingName !== null &&
              callThreadsSignal(node, bindingName, kind)
            ) {
              return;
            }

            context.report({ node, messageId: "missingQuerySignal" });
          },
          "Program:exit"() {
            const queryFunctions = new Set<AstNode>();
            for (const reference of queryFnReferences) {
              const queryFunction = resolveLocalQueryFunction(reference);
              if (queryFunction !== null) {
                queryFunctions.add(queryFunction);
              }
            }

            for (const { kind, node, owner } of networkCalls) {
              if (!queryFunctions.has(owner)) {
                continue;
              }
              const bindingName = signalBindingName(owner);
              if (
                bindingName !== null &&
                callThreadsSignal(node, bindingName, kind)
              ) {
                continue;
              }
              context.report({ node, messageId: "missingQuerySignal" });
            }
          },
        };
      },
    },
  },
});
