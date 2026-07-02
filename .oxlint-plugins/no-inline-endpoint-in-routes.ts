// Require API endpoints to live in their own default-export
// `{ config, handler }` modules, not defined inline in a route file.
//
// createSafeHandler / createSafeRootHandler / createSafePublicHandler bundle a
// route's schema, permissions, and typed error handling together with its
// business logic. When an endpoint is defined inline in a `routes.ts` file,
// that config drifts away from the endpoint module convention: schemas and
// permissions end up far from the route wiring, and the mounting-side rule
// (`require-safe-route-handlers`, which expects each route to mount
// `endpoint.handler`) has nothing to point at. This rule is the definition-side
// complement — it flags a `createSafe*Handler` CALL inside a route file, so new
// endpoints land in their own module and the route file only wires them.
//
// The rule is enabled only on route files (scoped in oxlint.config.ts to
// `**/routes.ts` and `**/*route.ts`, matching `require-safe-route-handlers`).
// Pre-existing inline definitions are grandfathered by turning the rule `off`
// for their files there; they are not migrated in this pass.
//
// Flagged (inside a route file):
//   const readThing = createSafeHandler({ config, handler });
//   const searchEndpoint = createSafeRootHandler(config, handler);
//
// Allowed:
//   import readThing from "./read-thing";      // endpoint module
//   .get("/", readThing.handler)               // route file only wires it
//   // createSafeHandler(...) called inside read-thing.ts (its own module)

import { getCalleeName } from "./utils.ts";

// The safe-handler factory family from `@/api/lib/api-handlers`. A bare
// identifier call to any of these defines an endpoint; a route file should
// import and mount one instead.
const SAFE_HANDLER_FACTORIES = new Set([
  "createSafeHandler",
  "createSafeRootHandler",
  "createSafePublicHandler",
]);

type AstNode = Record<string, unknown> & { type: string };

type CallExpressionNode = AstNode & { callee: unknown };

type RuleContext = {
  report: (descriptor: {
    data: { factory: string };
    messageId: "inlineEndpoint";
    node: unknown;
  }) => void;
};

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string";

const isCallExpression = (node: unknown): node is CallExpressionNode =>
  isAstNode(node) && node.type === "CallExpression" && "callee" in node;

export default {
  meta: { name: "no-inline-endpoint-in-routes" },
  rules: {
    "no-inline-endpoint-in-routes": {
      meta: {
        type: "problem",
        messages: {
          inlineEndpoint:
            "`{{factory}}` must not define an endpoint inline in a route " +
            "file. Move the schema, permissions, and handler into a " +
            "default-export `{ config, handler }` endpoint module and mount " +
            "`endpoint.handler` here. If this file is an established protocol/" +
            "public/dev exception, grandfather it in oxlint.config.ts.",
        },
      },
      create(context: RuleContext) {
        return {
          CallExpression(node: unknown) {
            if (!isCallExpression(node)) {
              return;
            }

            // Only bare identifier calls (`createSafeHandler(...)`) define an
            // endpoint here; `getCalleeName` returns a dotted name for member
            // calls, which never match the factory set.
            const calleeName = getCalleeName(node.callee);
            if (
              calleeName === null ||
              !SAFE_HANDLER_FACTORIES.has(calleeName)
            ) {
              return;
            }

            context.report({
              node,
              messageId: "inlineEndpoint",
              data: { factory: calleeName },
            });
          },
        };
      },
    },
  },
};
