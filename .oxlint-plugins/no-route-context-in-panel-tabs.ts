import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  memberPropertyName,
  resolveImportedExpressionForEnforcement,
} from "./utils.ts";

export const GLOBALLY_MOUNTED_UI = [
  "apps/web/src/**/*inspector*.tsx",
  "apps/web/src/components/inspector/**/*.tsx",
  "apps/web/src/components/inspector/**/*.ts",
  "apps/web/src/features/knowledge/playbook-editor/playbook-draft-view.tsx",
  "apps/web/src/features/knowledge/views/tools/tool-detail-panel-view.tsx",
  "apps/web/src/components/workspaces/tasks/task-detail-panel.tsx",
  "apps/web/src/components/workspaces/matter-metadata-sheet.tsx",
  "apps/web/src/components/workspaces/hooks/use-start-workflow.ts",
  "apps/web/src/components/workspaces/hooks/use-create-b-boxes.ts",
] as const;

const ROUTE_METHODS = new Set([
  "useRouteContext",
  "useParams",
  "useLoaderData",
]);

// Panel tabs survive navigation between route families. Even a nonthrowing
// route-context read can lose identity on another route; use the provider.
// Accept provider hooks and navigation. Reject imported router context hooks
// and any statically named useRouteContext member or destructured method;
// route API objects can originate outside this module. Dynamic property names
// and context reads hidden inside another module are outside this detector.
export default eslintCompatPlugin({
  meta: { name: "no-route-context-in-panel-tabs" },
  rules: {
    "no-route-context-in-panel-tabs": {
      meta: {
        type: "problem",
        messages: {
          routeContext:
            "Panel tabs render across route families and must not read route-scoped context directly. Use useAuthenticatedUser or useMaybeAuthenticatedUser from @/lib/authenticated-user-context for identity, and shared provider hooks for other context.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            // Member reads are reported below, including aliases captured
            // before the call and APIs returned directly by getRouteApi.
            if (node.callee.type === "MemberExpression") {
              return;
            }
            const hook = resolveImportedExpressionForEnforcement(
              context,
              node.callee,
            );
            if (
              hook?.source === "@tanstack/react-router" &&
              (hook.imported === "useRouteContext" ||
                hook.imported === "useParams" ||
                hook.imported === "useMatch")
            ) {
              if (hook.imported === "useMatch") {
                const options = node.arguments[0];
                const nonStrict =
                  options?.type === "ObjectExpression" &&
                  options.properties.some(
                    (property) =>
                      property.type === "Property" &&
                      getPropertyName(property.key) === "strict" &&
                      property.value.type === "Literal" &&
                      property.value.value === false,
                  );
                if (nonStrict) {
                  return;
                }
              }
              context.report({ node, messageId: "routeContext" });
            }
          },
          MemberExpression(node) {
            const method = memberPropertyName(node);
            if (method !== null && ROUTE_METHODS.has(method)) {
              context.report({ node, messageId: "routeContext" });
            }
          },
          VariableDeclarator(node) {
            if (node.id.type !== "ObjectPattern") {
              return;
            }
            for (const property of node.id.properties) {
              if (
                property.type === "Property" &&
                getPropertyName(property.key) === "useRouteContext"
              ) {
                context.report({ node: property, messageId: "routeContext" });
              }
            }
          },
        };
      },
    },
  },
});
