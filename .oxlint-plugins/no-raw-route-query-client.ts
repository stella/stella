import { getImportedName, getPropertyName, isIdentifier } from "./utils.ts";

const RAW_QUERY_CLIENT_METHODS = new Map([
  ["ensureQueryData", "ensureRouteQueryData"],
  ["ensureInfiniteQueryData", "ensureRouteInfiniteQueryData"],
  ["fetchQuery", "prefetchRouteQuery"],
  ["prefetchQuery", "prefetchRouteQuery"],
]);
const RAW_QUERY_CLIENT_RECEIVERS = new Set(["qc", "queryClient"]);
const ROUTE_QUERY_HELPERS_MODULE = "@/lib/react-query";
const GENERIC_ROUTE_QUERY_HELPERS = new Map([
  ["ensureCriticalQueryData", "ensureRouteQueryData"],
  ["prefetchNonCriticalQuery", "prefetchRouteQuery"],
]);

const ROUTE_LOADER_HOOKS = new Set(["beforeLoad", "loader"]);

const isQueryClientReceiver = (node) => {
  if (!node) {
    return false;
  }

  if (node.type === "Identifier") {
    return RAW_QUERY_CLIENT_RECEIVERS.has(node.name);
  }

  if (node.type !== "MemberExpression" || node.computed) {
    return false;
  }

  const receiverName = getPropertyName(node.property);
  return receiverName === "queryClient";
};

const findRouteLoaderHook = (node) => {
  let current = node.parent;

  while (current) {
    if (current.type === "Property") {
      const name = getPropertyName(current.key);

      if (name !== null && ROUTE_LOADER_HOOKS.has(name)) {
        return name;
      }
    }

    current = current.parent;
  }

  return null;
};

export default {
  meta: { name: "no-raw-route-query-client" },
  rules: {
    "no-raw-route-query-client": {
      meta: {
        type: "problem",
        messages: {
          noRawRouteQueryClient:
            "Raw queryClient.{{method}} inside route {{hook}} " +
            "is forbidden. Use {{replacement}}(...), so route-seeded " +
            "queries carry a freshness window.",
          noGenericRouteQueryHelper:
            "Generic {{helper}} inside route {{hook}} is forbidden. " +
            "Use {{replacement}}(...), so route-seeded queries carry " +
            "a freshness window.",
        },
      },
      create(context) {
        const genericHelperAliases = new Map();
        const reactQueryNamespaces = new Set();

        return {
          ImportDeclaration(node) {
            if (node.source?.value !== ROUTE_QUERY_HELPERS_MODULE) {
              return;
            }

            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportNamespaceSpecifier") {
                reactQueryNamespaces.add(specifier.local.name);
                continue;
              }
              if (specifier.type !== "ImportSpecifier") {
                continue;
              }

              const importedName = getImportedName(specifier);
              const replacement =
                importedName === null
                  ? undefined
                  : GENERIC_ROUTE_QUERY_HELPERS.get(importedName);
              if (replacement === undefined) {
                continue;
              }

              genericHelperAliases.set(specifier.local.name, {
                helper: importedName,
                replacement,
              });
            }
          },

          CallExpression(node) {
            const hook = findRouteLoaderHook(node);

            if (hook === null) {
              return;
            }

            const callee = node.callee;
            if (isIdentifier(callee)) {
              const helper = genericHelperAliases.get(callee.name);
              if (helper !== undefined) {
                context.report({
                  node,
                  messageId: "noGenericRouteQueryHelper",
                  data: { hook, ...helper },
                });
                return;
              }
            }

            if (
              callee.type === "MemberExpression" &&
              callee.computed === false &&
              isIdentifier(callee.object) &&
              reactQueryNamespaces.has(callee.object.name)
            ) {
              const helperName = getPropertyName(callee.property);
              const replacement =
                helperName === null
                  ? undefined
                  : GENERIC_ROUTE_QUERY_HELPERS.get(helperName);

              if (replacement !== undefined) {
                context.report({
                  node,
                  messageId: "noGenericRouteQueryHelper",
                  data: { helper: helperName, hook, replacement },
                });
                return;
              }
            }

            if (callee.type !== "MemberExpression" || callee.computed) {
              return;
            }

            if (!isQueryClientReceiver(callee.object)) {
              return;
            }

            const method = getPropertyName(callee.property);
            const replacement =
              method === null ? undefined : RAW_QUERY_CLIENT_METHODS.get(method);

            if (replacement === undefined) {
              return;
            }

            context.report({
              node,
              messageId: "noRawRouteQueryClient",
              data: { method, hook, replacement },
            });
          },
        };
      },
    },
  },
};
