// Require normal API routes to mount safe handler objects.
//
// Stella's authenticated application endpoints should export endpoint objects
// from createSafeHandler/createSafeRootHandler and mount `endpoint.handler` in
// routes.ts. This keeps schemas, permissions, typed error handling, and branded
// context together.
//
// Safe patterns:
//   .get("/", readThing.handler)
//   .post("/", createThing.handler, { body: createThing.config.body })
//
// Flagged:
//   .get("/", async (ctx) => ...)
//   .post("/", handler)
//   .delete("/", rawHandler, { permissions: ... })
//
// Protocol, public, streaming, and dev-only routes may disable the sibling
// `require-safe-route-handlers` rule in oxlint.config.ts with a short
// justification. `no-direct-handler-config` remains applicable because Elysia
// mutates route options regardless of the endpoint's authentication model.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { getPropertyName, isAstNode } from "./utils.ts";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

type MemberExpressionNode = AstNode & {
  computed: boolean;
  property: unknown;
};

type CallExpressionNode = AstNode & {
  arguments: unknown[];
  callee: unknown;
};

type ObjectExpressionNode = AstNode & { properties: unknown[] };

const isMemberExpression = (node: unknown): node is MemberExpressionNode =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  typeof node.computed === "boolean" &&
  "property" in node;

const isCallExpression = (node: unknown): node is CallExpressionNode =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  Array.isArray(node.arguments) &&
  "callee" in node;

const isObjectExpression = (node: unknown): node is ObjectExpressionNode =>
  isAstNode(node) &&
  node.type === "ObjectExpression" &&
  Array.isArray(node.properties);

const isSafeHandlerMember = (node: unknown): node is MemberExpressionNode =>
  isMemberExpression(node) &&
  !node.computed &&
  getPropertyName(node.property) === "handler";

const isDirectHandlerConfig = (node: unknown): node is MemberExpressionNode =>
  isMemberExpression(node) &&
  !node.computed &&
  getPropertyName(node.property) === "config";

const endpointConfigProperty = (node: unknown, property: string) => {
  if (
    !isMemberExpression(node) ||
    node.computed ||
    getPropertyName(node.property) !== property ||
    !isMemberExpression(node.object) ||
    node.object.computed ||
    getPropertyName(node.object.property) !== "config" ||
    !isAstNode(node.object.object) ||
    node.object.object.type !== "Identifier" ||
    typeof node.object.object.name !== "string"
  ) {
    return null;
  }
  return node.object.object.name;
};

const hasAccountAccessProjection = (options: unknown) => {
  if (!isObjectExpression(options)) {
    // No options object means no forwarded permissions for this rule to pair.
    return true;
  }

  const properties = options.properties.filter(
    (property): property is AstNode =>
      isAstNode(property) && property.type === "Property",
  );
  const forwardedPermissions = properties.flatMap((property) =>
    getPropertyName(property.key) === "permissions"
      ? [endpointConfigProperty(property.value, "permissions")]
      : [],
  );
  if (forwardedPermissions.length === 0) {
    return true;
  }

  const forwardedAccountAccess = properties.flatMap((property) =>
    getPropertyName(property.key) === "accountAccess"
      ? [endpointConfigProperty(property.value, "accountAccess")]
      : [],
  );
  return forwardedPermissions.every(
    (endpointName) =>
      endpointName === null || forwardedAccountAccess.includes(endpointName),
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-safe-route-handlers" },
  rules: {
    "no-direct-handler-config": {
      meta: {
        type: "problem",
        messages: {
          noDirectHandlerConfig:
            "Do not pass `endpoint.config` directly to Elysia. Elysia " +
            "normalizes route options in place, which can delete safe-handler " +
            "metadata such as permissions. Pass a fresh object selecting the " +
            "route fields instead.",
          missingAccountAccess:
            "When forwarding `endpoint.config.permissions` to a route, also " +
            "forward `endpoint.config.accountAccess` from the same endpoint " +
            "so the registered access guard retains the complete policy.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node: unknown) {
            if (
              !isCallExpression(node) ||
              !isMemberExpression(node.callee) ||
              node.callee.computed
            ) {
              return;
            }

            const method = getPropertyName(node.callee.property);
            if (method === null || !HTTP_METHODS.has(method)) {
              return;
            }

            const routeOptions = node.arguments[2];
            const reportNode = isAstNode(routeOptions) ? routeOptions : node;
            if (!isDirectHandlerConfig(routeOptions)) {
              if (!hasAccountAccessProjection(routeOptions)) {
                context.report({
                  node: reportNode,
                  messageId: "missingAccountAccess",
                });
              }
              return;
            }

            context.report({
              node: reportNode,
              messageId: "noDirectHandlerConfig",
            });
          },
        };
      },
    },
    "require-safe-route-handlers": {
      meta: {
        type: "problem",
        messages: {
          requireSafeHandler:
            "API route .{{method}}() must mount a safe handler object " +
            "as `endpoint.handler`. Move route schemas and permissions " +
            "into a createSafeHandler/createSafeRootHandler endpoint, or " +
            "document this file as an explicit protocol/public/dev exception.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node: unknown) {
            if (!isCallExpression(node)) {
              return;
            }

            if (!isMemberExpression(node.callee) || node.callee.computed) {
              return;
            }

            const method = getPropertyName(node.callee.property);

            if (method === null || !HTTP_METHODS.has(method)) {
              return;
            }

            const routeHandler = node.arguments[1];

            if (
              routeHandler === undefined ||
              isSafeHandlerMember(routeHandler)
            ) {
              return;
            }
            if (!isAstNode(routeHandler)) {
              return;
            }

            context.report({
              node: routeHandler,
              messageId: "requireSafeHandler",
              data: { method },
            });
          },
        };
      },
    },
  },
});
