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
// Protocol, public, streaming, and dev-only routes should disable this rule in
// oxlint.config.ts with a short justification.

import { getPropertyName } from "./utils.ts";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

type AstNode = Record<string, unknown> & { type: string };

type MemberExpressionNode = AstNode & {
  computed: boolean;
  property: unknown;
};

type CallExpressionNode = AstNode & {
  arguments: unknown[];
  callee: unknown;
};

type RuleContext = {
  report: (descriptor: {
    data: { method: string };
    messageId: "requireSafeHandler";
    node: unknown;
  }) => void;
};

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

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

const isSafeHandlerMember = (node: unknown) =>
  isMemberExpression(node) &&
  !node.computed &&
  getPropertyName(node.property) === "handler";

export default {
  meta: { name: "require-safe-route-handlers" },
  rules: {
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
      create(context: RuleContext) {
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
};
