// Require route loaders to prefetch the queries their component suspends on.
//
// A route component that calls `useSuspenseQuery(someOptions(...))` without the
// route loader prefetching that same query forces a render-fetch waterfall: on
// a cold visit the router resolves the route, the component mounts, suspends,
// and only THEN starts the fetch — an extra sequential network round on every
// cold navigation. TanStack Router loaders (`loader:` in `createFileRoute`
// options) start the fetch during navigation, in parallel with code-split
// chunk loading, via the helpers in `apps/web/src/lib/react-query.ts`
// (`ensureRouteQueryData` for critical/blocking data, `prefetchRouteQuery` for
// non-blocking warmup). With the loader priming the cache, `useSuspenseQuery`
// in the component consumes a warm cache instead of opening a new round.
//
// Single-file AST analysis, scoped to route files (`createFileRoute(...)`):
//   - Flags `useSuspenseQuery(factory(...))` / `useSuspenseQuery(factory)` when
//     the route has no `loader`.
//   - Flags the same when a `loader` exists but never references the factory
//     identifier (any reference inside the loader body counts — typically
//     inside `ensureRouteQueryData` / `prefetchRouteQuery`).
//
// Safe (not flagged):
//   - `useSuspenseQuery` whose argument is a member expression or other shape
//     the rule can't statically attribute to a factory identifier.
//   - `useSuspenseQuery` in a non-route file (no `createFileRoute`).
//   - A route whose loader references the factory identifier.

import { getPropertyName, isIdentifier, unwrapExpression } from "./utils.ts";

const CREATE_FILE_ROUTE = "createFileRoute";
const SUSPENSE_HOOK = "useSuspenseQuery";
const LOADER_KEY = "loader";

const isCreateFileRouteCall = (callee) =>
  isIdentifier(callee, CREATE_FILE_ROUTE);

// `createFileRoute("...")({ ... })` — the outer call whose callee is itself the
// `createFileRoute("...")` call. The first argument is the route options object.
const isCreateFileRouteOptionsCall = (callee) =>
  callee?.type === "CallExpression" && isCreateFileRouteCall(callee.callee);

const isSuspenseCallee = (callee) => {
  if (isIdentifier(callee, SUSPENSE_HOOK)) {
    return true;
  }
  return (
    callee?.type === "MemberExpression" &&
    callee.computed === false &&
    isIdentifier(callee.property, SUSPENSE_HOOK)
  );
};

// Resolve the factory identifier a `useSuspenseQuery` call depends on:
//   useSuspenseQuery(factory(...)) -> "factory"
//   useSuspenseQuery(factory)      -> "factory"
// Returns null for any other argument shape (member expressions, object
// literals, etc.) so the rule never guesses.
const suspenseFactoryName = (node) => {
  if (!isSuspenseCallee(node.callee)) {
    return null;
  }
  const arg = unwrapExpression(node.arguments?.[0]);
  if (arg?.type === "CallExpression" && isIdentifier(arg.callee)) {
    return arg.callee.name;
  }
  if (isIdentifier(arg)) {
    return arg.name;
  }
  return null;
};

const isInsideLoader = (node) => {
  let current = node.parent;
  while (current) {
    if (
      current.type === "Property" &&
      getPropertyName(current.key) === LOADER_KEY
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

export default {
  meta: { name: "require-loader-prefetch" },
  rules: {
    "require-loader-prefetch": {
      meta: {
        type: "problem",
        messages: {
          missingLoaderPrefetch:
            "Route component calls useSuspenseQuery({{factory}}(...)) but the " +
            "route defines no `loader`, so this query fetches only after the " +
            "component mounts and suspends — an extra sequential network round " +
            "on cold navigation. Prefetch the same query options in the route " +
            "`loader` via ensureRouteQueryData (blocking, critical data) or " +
            "prefetchRouteQuery (non-blocking) from @/lib/react-query, so the " +
            "fetch starts during navigation and useSuspenseQuery consumes the " +
            "warm cache.",
          factoryNotPrefetched:
            "Route component calls useSuspenseQuery({{factory}}(...)) but the " +
            "route `loader` never references {{factory}}, so this query still " +
            "fetches on mount — an extra sequential network round on cold " +
            "navigation. Prefetch {{factory}}(...) in the `loader` via " +
            "ensureRouteQueryData (blocking, critical data) or " +
            "prefetchRouteQuery (non-blocking) from @/lib/react-query; " +
            "useSuspenseQuery in the component then consumes the warm cache.",
        },
      },
      create(context) {
        let isRouteFile = false;
        let routeOptions = null;
        const suspenseCalls = [];
        const referencedInLoader = new Set();

        return {
          CallExpression(node) {
            const callee = node.callee;

            if (isCreateFileRouteCall(callee)) {
              isRouteFile = true;
            }

            if (isCreateFileRouteOptionsCall(callee)) {
              isRouteFile = true;
              const optionsArg = node.arguments?.[0];
              if (
                routeOptions === null &&
                optionsArg?.type === "ObjectExpression"
              ) {
                routeOptions = optionsArg;
              }
            }

            const factory = suspenseFactoryName(node);
            if (factory !== null) {
              suspenseCalls.push({ node, factory });
            }
          },

          Identifier(node) {
            if (isInsideLoader(node)) {
              referencedInLoader.add(node.name);
            }
          },

          "Program:exit"() {
            // Only route files with an inline options object are analyzable;
            // a non-inline options argument can't be statically inspected.
            if (
              !isRouteFile ||
              routeOptions === null ||
              suspenseCalls.length === 0
            ) {
              return;
            }

            const hasLoader = routeOptions.properties.some(
              (prop) =>
                prop.type === "Property" &&
                getPropertyName(prop.key) === LOADER_KEY,
            );

            for (const { node, factory } of suspenseCalls) {
              if (!hasLoader) {
                context.report({
                  node,
                  messageId: "missingLoaderPrefetch",
                  data: { factory },
                });
                continue;
              }

              if (!referencedInLoader.has(factory)) {
                context.report({
                  node,
                  messageId: "factoryNotPrefetched",
                  data: { factory },
                });
              }
            }
          },
        };
      },
    },
  },
};
