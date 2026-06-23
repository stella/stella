import { getImportedName, getPropertyName, isIdentifier } from "./utils.ts";

const RAW_QUERY_CLIENT_METHODS = new Map([
  ["ensureQueryData", "ensureRouteQueryData"],
  ["ensureInfiniteQueryData", "ensureRouteInfiniteQueryData"],
  ["fetchQuery", "prefetchRouteQuery"],
  ["prefetchQuery", "prefetchRouteQuery"],
]);
const RAW_QUERY_CLIENT_RECEIVERS = new Set(["qc", "queryClient"]);
const TANSTACK_QUERY_MODULE = "@tanstack/react-query";
const ROUTE_QUERY_HELPERS_MODULE = "@/lib/react-query";
const GENERIC_ROUTE_QUERY_HELPERS = new Map([
  ["ensureCriticalQueryData", "ensureRouteQueryData"],
  ["prefetchNonCriticalQuery", "prefetchRouteQuery"],
]);
const QUERY_SUBSCRIPTION_HOOKS = new Set([
  "useInfiniteQuery",
  "useQueries",
  "useQuery",
  "useSuspenseInfiniteQuery",
  "useSuspenseQueries",
  "useSuspenseQuery",
]);

const ROUTE_LOADER_HOOKS = new Set(["beforeLoad", "loader"]);
const ROUTE_PENDING_COMPONENT_HOOK = "pendingComponent";

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

const findPendingComponentCandidate = (node) => {
  let current = node.parent;

  while (current) {
    if (current.type === "Property") {
      const name = getPropertyName(current.key);

      if (name === ROUTE_PENDING_COMPONENT_HOOK) {
        return ROUTE_PENDING_COMPONENT_HOOK;
      }
    }

    if (current.type === "FunctionDeclaration" && isIdentifier(current.id)) {
      return current.id.name;
    }

    if (current.type === "VariableDeclarator" && isIdentifier(current.id)) {
      return current.id.name;
    }

    current = current.parent;
  }

  return null;
};

const getQuerySubscriptionHookName = (
  callee,
  queryHookAliases,
  tanstackQueryNamespaces,
) => {
  if (isIdentifier(callee) && queryHookAliases.has(callee.name)) {
    return callee.name;
  }

  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    !isIdentifier(callee.object) ||
    !tanstackQueryNamespaces.has(callee.object.name)
  ) {
    return null;
  }

  const hookName = getPropertyName(callee.property);
  return hookName !== null && QUERY_SUBSCRIPTION_HOOKS.has(hookName)
    ? hookName
    : null;
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
          noQueryHookInPendingComponent:
            "TanStack Query subscription hook {{hook}} is forbidden " +
            "inside route pendingComponent {{component}}. Read cached " +
            "data synchronously with useQueryClient().getQueryData(...) " +
            "so abandoned pending renders cannot receive async state updates.",
        },
      },
      create(context) {
        const genericHelperAliases = new Map();
        const pendingComponentNames = new Set();
        const pendingQueryHookCalls = [];
        const queryHookAliases = new Set();
        const routeQueryHelperNamespaces = new Set();
        const tanstackQueryNamespaces = new Set();

        return {
          ImportDeclaration(node) {
            if (node.source?.value === TANSTACK_QUERY_MODULE) {
              for (const specifier of node.specifiers) {
                if (specifier.type === "ImportNamespaceSpecifier") {
                  tanstackQueryNamespaces.add(specifier.local.name);
                  continue;
                }
                if (specifier.type !== "ImportSpecifier") {
                  continue;
                }

                const importedName = getImportedName(specifier);
                if (
                  importedName !== null &&
                  QUERY_SUBSCRIPTION_HOOKS.has(importedName)
                ) {
                  queryHookAliases.add(specifier.local.name);
                }
              }
              return;
            }

            if (node.source?.value !== ROUTE_QUERY_HELPERS_MODULE) {
              return;
            }

            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportNamespaceSpecifier") {
                routeQueryHelperNamespaces.add(specifier.local.name);
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

          Property(node) {
            const name = getPropertyName(node.key);
            if (name !== ROUTE_PENDING_COMPONENT_HOOK) {
              return;
            }
            if (isIdentifier(node.value)) {
              pendingComponentNames.add(node.value.name);
            }
          },

          CallExpression(node) {
            const hook = findRouteLoaderHook(node);
            const callee = node.callee;

            if (hook !== null) {
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
                routeQueryHelperNamespaces.has(callee.object.name)
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

              if (
                callee.type === "MemberExpression" &&
                !callee.computed &&
                isQueryClientReceiver(callee.object)
              ) {
                const method = getPropertyName(callee.property);
                const replacement =
                  method === null
                    ? undefined
                    : RAW_QUERY_CLIENT_METHODS.get(method);

                if (replacement === undefined) {
                  return;
                }

                context.report({
                  node,
                  messageId: "noRawRouteQueryClient",
                  data: { method, hook, replacement },
                });
                return;
              }
            }

            const pendingComponent = findPendingComponentCandidate(node);
            if (pendingComponent === null) {
              return;
            }

            const queryHookName = getQuerySubscriptionHookName(
              callee,
              queryHookAliases,
              tanstackQueryNamespaces,
            );
            if (queryHookName === null) {
              return;
            }

            pendingQueryHookCalls.push({
              component: pendingComponent,
              hook: queryHookName,
              node,
            });
          },

          "Program:exit"() {
            for (const { component, hook, node } of pendingQueryHookCalls) {
              if (
                component !== ROUTE_PENDING_COMPONENT_HOOK &&
                !pendingComponentNames.has(component)
              ) {
                continue;
              }

              context.report({
                node,
                messageId: "noQueryHookInPendingComponent",
                data: { component, hook },
              });
            }
          },
        };
      },
    },
  },
};
