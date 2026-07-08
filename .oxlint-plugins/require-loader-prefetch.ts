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
// Cross-file, one-hop check for colocated route components: the single-file
// analysis above is blind to a `useSuspenseQuery(factory(...))` call living in
// a sibling file imported by the route (the codebase convention for colocated,
// non-route-generating files is a dash-prefixed directory next to the route,
// e.g. `-components/`, `-hooks/`, `-queries/`, imported via the `@/routes/...`
// alias — TanStack Router excludes `-`-prefixed paths from route generation).
// A real instance of this shipped on `/settings/account/connections` before
// being caught by the e2e depth guard: the page component had no
// `useSuspenseQuery` of its own, it all lived in a child card component.
//
// To close that gap without a real module resolver: once a file is confirmed
// to be a route file with an inline options object (the same precondition the
// single-file check already requires), each `@/routes/.../-<dir>/...` import
// it declares is resolved to an absolute path by reusing the *linted file's
// own* path up to its `/routes/` segment as the alias root (mirrors the
// `"@/*": ["./src/*"]` tsconfig path). The resolved file is read once — bounded
// to that one hop, its own imports are never followed — and scanned with a
// regex for the same two `useSuspenseQuery(...)` shapes the AST check
// recognizes. Any factory it finds is checked against the route's `loader`
// exactly like an in-file suspense call would be.
//
// Safe (not flagged):
//   - `useSuspenseQuery` whose argument is a member expression or other shape
//     the rule can't statically attribute to a factory identifier (in-file or
//     in a colocated import).
//   - `useSuspenseQuery` in a non-route file (no `createFileRoute`) — including
//     when that file is itself a route's colocated component and is linted
//     directly rather than through the importing route.
//   - A route whose loader references the factory identifier.
//   - A colocated import that isn't under a dash-prefixed directory, or that
//     can't be read as a sibling `.tsx`/`.ts` file (no fs read is attempted
//     unless the file is already a confirmed route file with such an import).
//
// Known limitation: the child-file scan is a raw-text regex, not a second AST
// parse, so it does not strip comments or string literals. A comment or
// string in the colocated file that happens to spell out
// `useSuspenseQuery(identifier(` / `useSuspenseQuery(identifier)` verbatim
// would false-positive. Judged an acceptable, rare edge case for the
// bounded/cheap scan this rule relies on; do not write that literal pattern
// in prose comments inside `-components`/`-hooks`/`-queries` files.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getPropertyName,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

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

const ROUTES_SEGMENT = "/routes/";
const COLOCATED_DIR_RE = /\/-[^/]+\//;

// A colocated, non-route-generating import: under `@/routes/...` and through
// a dash-prefixed directory (`-components/`, `-hooks/`, `-queries/`, ...).
const isColocatedRouteImport = (source) =>
  source.startsWith("@/routes/") && COLOCATED_DIR_RE.test(source);

// Resolve a `@/routes/...` specifier to an absolute path by reusing the
// currently-linted file's own path up to its `/routes/` segment as the alias
// root — mirrors the `"@/*": ["./src/*"]` tsconfig path without a real module
// resolver. Returns null if the linted file isn't itself under a `routes`
// directory (shouldn't happen for a confirmed route file, but fails closed).
const resolveColocatedImportBase = (filename, source) => {
  const routesIndex = filename.lastIndexOf(ROUTES_SEGMENT);
  if (routesIndex === -1) {
    return null;
  }
  const aliasRoot = filename.slice(0, routesIndex);
  return join(aliasRoot, source.slice("@/".length));
};

// Bounded, one-hop read: try the two extensions a colocated TS/TSX import can
// resolve to. No further imports of the child file are followed.
const readColocatedFile = (basePath) => {
  for (const extension of [".tsx", ".ts"]) {
    try {
      return readFileSync(`${basePath}${extension}`, "utf8");
    } catch {
      // Try the next extension; if neither exists this is a shape the
      // simplified alias resolution can't handle (e.g. a directory index) —
      // acceptable since this is a best-effort bounded check, not a resolver.
    }
  }
  return null;
};

// Regex counterpart of `suspenseFactoryName`, scanning raw source text for
// the same two argument shapes: `useSuspenseQuery(factory(...))` and
// `useSuspenseQuery(factory)`. The character right after the identifier
// disambiguates them from a member-expression argument the AST check would
// also decline to attribute (e.g. `useSuspenseQuery(factory.options())`).
const CHILD_SUSPENSE_RE = /useSuspenseQuery\(\s*([A-Za-z_$][\w$]*)\s*([(),])/g;

const suspenseFactoriesInSource = (sourceText) => {
  const factories = new Set();
  for (const match of sourceText.matchAll(CHILD_SUSPENSE_RE)) {
    factories.add(match[1]);
  }
  return factories;
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
          childMissingLoaderPrefetch:
            "Route imports {{importPath}}, whose component calls " +
            "useSuspenseQuery({{factory}}(...)), but the route defines no " +
            "`loader`, so this query fetches only after the child component " +
            "mounts and suspends — an extra sequential network round on cold " +
            "navigation. Prefetch the same query options in the route " +
            "`loader` via ensureRouteQueryData (blocking, critical data) or " +
            "prefetchRouteQuery (non-blocking) from @/lib/react-query, so the " +
            "fetch starts during navigation and useSuspenseQuery in the child " +
            "component consumes the warm cache.",
          childFactoryNotPrefetched:
            "Route imports {{importPath}}, whose component calls " +
            "useSuspenseQuery({{factory}}(...)), but the route `loader` never " +
            "references {{factory}}, so this query still fetches on mount — " +
            "an extra sequential network round on cold navigation. Prefetch " +
            "{{factory}}(...) in the `loader` via ensureRouteQueryData " +
            "(blocking, critical data) or prefetchRouteQuery (non-blocking) " +
            "from @/lib/react-query; useSuspenseQuery in the child component " +
            "then consumes the warm cache.",
        },
      },
      create(context) {
        let isRouteFile = false;
        let routeOptions = null;
        const suspenseCalls = [];
        const referencedInLoader = new Set();
        const colocatedImports = [];

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

          ImportDeclaration(node) {
            if (
              isStringLiteral(node.source) &&
              isColocatedRouteImport(node.source.value)
            ) {
              colocatedImports.push({ node, source: node.source.value });
            }
          },

          "Program:exit"() {
            // Only route files with an inline options object are analyzable;
            // a non-inline options argument can't be statically inspected.
            if (!isRouteFile || routeOptions === null) {
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

            if (colocatedImports.length === 0) {
              return;
            }

            const filename = context.filename ?? context.getFilename?.();
            if (typeof filename !== "string") {
              return;
            }

            for (const { node, source } of colocatedImports) {
              const basePath = resolveColocatedImportBase(filename, source);
              if (basePath === null) {
                continue;
              }

              const childSource = readColocatedFile(basePath);
              if (childSource === null) {
                continue;
              }

              for (const factory of suspenseFactoriesInSource(childSource)) {
                if (!hasLoader) {
                  context.report({
                    node,
                    messageId: "childMissingLoaderPrefetch",
                    data: { factory, importPath: source },
                  });
                  continue;
                }

                if (!referencedInLoader.has(factory)) {
                  context.report({
                    node,
                    messageId: "childFactoryNotPrefetched",
                    data: { factory, importPath: source },
                  });
                }
              }
            }
          },
        };
      },
    },
  },
};
