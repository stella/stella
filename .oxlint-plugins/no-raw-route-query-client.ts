import { getPropertyName } from "./utils.ts";

const RAW_QUERY_CLIENT_METHODS = new Set(["ensureQueryData", "prefetchQuery"]);
const RAW_QUERY_CLIENT_RECEIVERS = new Set(["qc", "queryClient"]);

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
            "is forbidden. Use ensureCriticalQueryData(...) " +
            "or prefetchNonCriticalQuery(...).",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (
              node.callee.type !== "MemberExpression" ||
              node.callee.computed
            ) {
              return;
            }

            if (!isQueryClientReceiver(node.callee.object)) {
              return;
            }

            const method = getPropertyName(node.callee.property);

            if (method === null || !RAW_QUERY_CLIENT_METHODS.has(method)) {
              return;
            }

            const hook = findRouteLoaderHook(node);

            if (hook === null) {
              return;
            }

            context.report({
              node,
              messageId: "noRawRouteQueryClient",
              data: { method, hook },
            });
          },
        };
      },
    },
  },
};
