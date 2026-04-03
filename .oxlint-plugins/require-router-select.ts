// Require `select` on TanStack Router hooks.
//
// useParams, useSearch, and useRouteContext subscribe to the
// entire params/search/context object when called without
// `select`. This causes unnecessary rerenders whenever any
// param or search value changes, even if the component only
// reads one field.
//
// Catches both standalone calls (useParams()) and route-
// scoped calls (Route.useParams()).

const HOOKS = new Set([
  "useParams",
  "useSearch",
  "useRouteContext",
]);

export default {
  meta: { name: "require-router-select" },
  rules: {
    "require-router-select": {
      meta: {
        type: "problem",
        messages: {
          missingSelect:
            "'{{hook}}' must be called with a " +
            "`select` option to avoid subscribing " +
            "to the entire {{kind}} object.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            let hookName: string | null = null;

            // useParams(...)
            if (
              callee.type === "Identifier" &&
              HOOKS.has(callee.name)
            ) {
              hookName = callee.name;
            }

            // Route.useParams(...)
            if (
              callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.property.type === "Identifier" &&
              HOOKS.has(callee.property.name)
            ) {
              hookName = callee.property.name;
            }

            if (hookName === null) {
              return;
            }

            const kind = hookName === "useParams"
              ? "params"
              : hookName === "useSearch"
                ? "search"
                : "context";

            const firstArg = node.arguments[0];

            // No arguments at all
            if (!firstArg) {
              context.report({
                node,
                messageId: "missingSelect",
                data: { hook: hookName, kind },
              });
              return;
            }

            // Non-inline argument (variable, call, spread) —
            // can't statically verify, report to push toward
            // the unambiguous inline pattern
            if (firstArg.type !== "ObjectExpression") {
              context.report({
                node,
                messageId: "missingSelect",
                data: { hook: hookName, kind },
              });
              return;
            }

            // Inline object argument — check for `select`
            const hasSelect = firstArg.properties.some(
              (prop) =>
                prop.type === "Property" &&
                prop.key.type === "Identifier" &&
                prop.key.name === "select",
            );
            if (!hasSelect) {
              context.report({
                node,
                messageId: "missingSelect",
                data: { hook: hookName, kind },
              });
            }
          },
        };
      },
    },
  },
};
