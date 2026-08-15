// Confine TanStack Router invalidation to its three owned lifecycle boundaries.
//
// `router.invalidate()` is navigation-grade work: it reruns route context,
// beforeLoad, loaders, and head resolution. Query mutations must not use it as
// a broad cache refresh. The workspace boundary is additionally constrained by
// its total `WorkspaceUpdate["type"] -> refresh scope` policy.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportLocalName,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const ROUTER_MODULE = "@tanstack/react-router";

const OWNED_INVALIDATION_FILES = new Set([
  "apps/web/src/app-providers.tsx",
  "apps/web/src/hooks/use-invalidate-session.ts",
  "apps/web/src/lib/workspaces/mutations.ts",
]);

export default eslintCompatPlugin({
  meta: { name: "no-raw-router-invalidation" },
  rules: {
    "no-raw-router-invalidation": {
      meta: {
        type: "problem",
        messages: {
          rawInvalidation:
            "`router.invalidate()` reruns the active route and may remount " +
            "local UI. Keep it inside an owned session, locale, or exhaustive " +
            "route-metadata refresh boundary; use query invalidation for data.",
        },
      },
      createOnce(context) {
        const useRouterNames = new Set<string>();
        const routerObjectNames = new Set<string>();
        const invalidateFunctionNames = new Set<string>();
        let isOwnedFile = false;

        return {
          before() {
            const filename = filenameForContext(context);
            isOwnedFile = [...OWNED_INVALIDATION_FILES].some((ownedFile) =>
              filename.endsWith(ownedFile),
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              node.source.value !== ROUTER_MODULE
            ) {
              return;
            }
            const specifiers = Array.isArray(node.specifiers)
              ? node.specifiers
              : [];
            for (const specifier of specifiers) {
              if (getImportedName(specifier) !== "useRouter") {
                continue;
              }
              const localName = getImportLocalName(specifier);
              if (localName !== null) {
                useRouterNames.add(localName);
              }
            }
          },
          VariableDeclarator(node) {
            if (
              !isAstNode(node.init) ||
              node.init.type !== "CallExpression" ||
              !isIdentifier(node.init.callee) ||
              !useRouterNames.has(node.init.callee.name)
            ) {
              return;
            }
            if (isIdentifier(node.id)) {
              routerObjectNames.add(node.id.name);
              return;
            }
            if (!isAstNode(node.id) || node.id.type !== "ObjectPattern") {
              return;
            }
            const properties = Array.isArray(node.id.properties)
              ? node.id.properties
              : [];
            for (const property of properties) {
              if (
                !isAstNode(property) ||
                property.type !== "Property" ||
                getPropertyName(property.key) !== "invalidate" ||
                !isIdentifier(property.value)
              ) {
                continue;
              }
              invalidateFunctionNames.add(property.value.name);
            }
          },
          CallExpression(node) {
            const callsDestructuredInvalidation =
              isIdentifier(node.callee) &&
              invalidateFunctionNames.has(node.callee.name);
            const callsRouterInvalidation =
              isAstNode(node.callee) &&
              node.callee.type === "MemberExpression" &&
              node.callee.computed === false &&
              isIdentifier(node.callee.object) &&
              routerObjectNames.has(node.callee.object.name) &&
              getPropertyName(node.callee.property) === "invalidate";
            if (
              isOwnedFile ||
              (!callsDestructuredInvalidation && !callsRouterInvalidation)
            ) {
              return;
            }
            context.report({ node, messageId: "rawInvalidation" });
          },
        };
      },
    },
  },
});
