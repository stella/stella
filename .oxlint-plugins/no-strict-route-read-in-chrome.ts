import { eslintCompatPlugin } from "@oxlint/plugins";
// Ban strict, route-scoped reads in persistent chrome.
//
// TanStack Router's `from:` reads are strict by default: `useRouteContext`,
// `useParams`, `useSearch`, `useMatch`, and `useLoaderData` throw
// `Invariant failed` when the named route is not in the current match tree.
// That is correct inside route content, which only renders under its own
// route. It is a latent crash in persistent chrome — the inspector, the
// sidebar, the docx editor — which stays mounted across navigation and
// therefore outlives the route it reads from. The moment the user opens a
// route in another tree (`/law/*` is top level, not under `/_protected`),
// the read throws and the surrounding error boundary swallows the component.
//
// The escape hatches are already the house style: `shouldThrow: false` on
// `useMatch`, `strict: false` on `useParams`/`useSearch`/`useRouteContext`
// (see inspector-panel.tsx, app-sidebar.tsx, the breadcrumbs). A route API's
// navigation helper is also safe because it does not read the current match;
// its route-bound data hooks are not. For identity, read
// `useMaybeAuthenticatedUser` from @/lib/authenticated-user-context rather
// than route context: the provider wraps every tree that can mount chrome, so
// the value does not disappear on navigation.
//
// Scope this rule with `overrides.files` in oxlint.config.ts for chrome
// modules; route and page content stays free to read strictly.

import { getImportedName, isIdentifier } from "./utils.ts";

const ROUTER_MODULE = "@tanstack/react-router";

// Route-scoped reads that throw when their `from` route is unmatched.
const STRICT_ROUTE_READS = new Set([
  "useLoaderData",
  "useMatch",
  "useParams",
  "useRouteContext",
  "useSearch",
]);

// Properties that opt a read out of throwing. `shouldThrow` covers useMatch;
// `strict` covers the route data hooks.
const OPT_OUT_PROPERTIES = new Set(["shouldThrow", "strict"]);

const isFalseLiteral = (node) =>
  node?.type === "Literal" && node.value === false;

/** True when the options object disables throwing on an unmatched route. */
const optsOutOfThrowing = (objectExpression) =>
  objectExpression.properties.some(
    (property) =>
      property.type === "Property" &&
      property.computed === false &&
      isIdentifier(property.key) &&
      OPT_OUT_PROPERTIES.has(property.key.name) &&
      isFalseLiteral(property.value),
  );

const namesRoute = (objectExpression) =>
  objectExpression.properties.some(
    (property) =>
      property.type === "Property" &&
      property.computed === false &&
      isIdentifier(property.key, "from"),
  );

export default eslintCompatPlugin({
  meta: { name: "no-strict-route-read-in-chrome" },
  rules: {
    "no-strict-route-read-in-chrome": {
      meta: {
        type: "problem",
        messages: {
          strictRouteRead:
            "Persistent chrome outlives the route it renders under, so a strict `from:` read throws Invariant failed on any route outside that tree. Pass `shouldThrow: false` (useMatch) or `strict: false` (route data hooks) and handle the absent case, or read the value from a provider that wraps every tree — useMaybeAuthenticatedUser for the current user.",
          routeApiStrictRead:
            "This route API data hook is bound strictly to one route, but persistent chrome mounts across routes. Use a non-strict router hook, or read the value from a provider that wraps every tree.",
        },
      },
      createOnce(context) {
        const getRouteApiAliases = new Set();
        const routeApiBindings = new Set();
        const strictReadAliases = new Map();

        return {
          before() {
            getRouteApiAliases.clear();
            routeApiBindings.clear();
            strictReadAliases.clear();
          },
          ImportDeclaration(node) {
            if (node.source?.value !== ROUTER_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (specifier.type !== "ImportSpecifier") {
                continue;
              }
              const imported = getImportedName(specifier);
              if (imported === "getRouteApi") {
                getRouteApiAliases.add(specifier.local.name);
                continue;
              }
              if (imported && STRICT_ROUTE_READS.has(imported)) {
                strictReadAliases.set(specifier.local.name, imported);
              }
            }
          },

          VariableDeclarator(node) {
            if (!isIdentifier(node.id)) {
              return;
            }
            const init = node.init;
            if (
              init?.type !== "CallExpression" ||
              !isIdentifier(init.callee) ||
              !getRouteApiAliases.has(init.callee.name)
            ) {
              return;
            }
            routeApiBindings.add(node.id.name);
          },

          CallExpression(node) {
            const callee = node.callee;
            if (
              callee?.type === "MemberExpression" &&
              callee.computed === false &&
              isIdentifier(callee.object) &&
              routeApiBindings.has(callee.object.name) &&
              isIdentifier(callee.property) &&
              STRICT_ROUTE_READS.has(callee.property.name)
            ) {
              context.report({ node, messageId: "routeApiStrictRead" });
              return;
            }

            if (!isIdentifier(callee) || !strictReadAliases.has(callee.name)) {
              return;
            }

            const options = node.arguments[0];
            // No options at all is the non-strict form (`useParams()`).
            if (options?.type !== "ObjectExpression") {
              return;
            }
            if (!namesRoute(options) || optsOutOfThrowing(options)) {
              return;
            }

            context.report({ node, messageId: "strictRouteRead" });
          },
        };
      },
    },
  },
});
