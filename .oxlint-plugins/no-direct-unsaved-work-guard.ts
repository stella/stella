// Keep unsaved-work guards behind `useUnsavedWork`.
//
// `apps/web/src/hooks/use-unsaved-work.ts` owns the route blocker, the
// `beforeunload` prompt, and the registry the stale-client refresh reads
// before reloading. A module that installs its own blocker or unload
// listener protects its work from navigation but not from that reload.
// `on<event>` handler assignment is already rejected by
// `unicorn/prefer-add-event-listener`.
//
// Flags:
//   import { useBlocker } from "@tanstack/react-router";
//   import { Block } from "@tanstack/react-router";
//   Router.useBlocker({ ... });                  // namespace import
//   window.addEventListener("beforeunload", handler);
//   target.addEventListener(`beforeunload`, handler);
//
// Allows:
//   useUnsavedWork({ surface, guard, isDirty });
//   window.addEventListener("pagehide", handler);
//   import { useRouter } from "@tanstack/react-router";

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isFileIn,
  isIdentifier,
  staticStringValue,
} from "./utils.ts";

const ROUTER_MODULE = "@tanstack/react-router";
const BLOCKER_EXPORTS = new Set(["Block", "useBlocker"]);
const UNLOAD_EVENT = "beforeunload";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const allowedFilesFromOptions = (options: unknown): string[] => {
  const configured = Array.isArray(options) ? options.at(0) : undefined;
  if (!isRecord(configured) || !Array.isArray(configured.allowedFiles)) {
    return [];
  }
  return configured.allowedFiles.filter(
    (value): value is string => typeof value === "string",
  );
};

// A string literal or an interpolation-free template literal.
// Unlike the shared memberPropertyName, accepts any node (null for a
// non-member) and reads an interpolation-free template key.
const staticMemberKey = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return null;
  }
  return node.computed === true
    ? staticStringValue(node.property)
    : getPropertyName(node.property);
};

export default eslintCompatPlugin({
  meta: { name: "no-direct-unsaved-work-guard" },
  rules: {
    "no-direct-unsaved-work-guard": {
      meta: {
        type: "problem",
        messages: {
          noDirectBlocker:
            "Guard unsaved work with useUnsavedWork from @/hooks/use-unsaved-work instead of TanStack's `{{name}}`: the hook also registers the work so the stale-client refresh does not reload over it.",
          noDirectUnloadListener:
            "Guard unsaved work with useUnsavedWork from @/hooks/use-unsaved-work instead of a raw `beforeunload` handler: the hook owns the unload prompt and registers the work so the stale-client refresh does not reload over it.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        const routerNamespaces = new Set<string>();

        return {
          before() {
            routerNamespaces.clear();
            return !isFileIn(context, allowedFilesFromOptions(context.options));
          },
          ImportDeclaration(node) {
            if (node.source.value !== ROUTER_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportNamespaceSpecifier") {
                routerNamespaces.add(specifier.local.name);
                continue;
              }
              const importedName = getImportedName(specifier);
              if (importedName !== null && BLOCKER_EXPORTS.has(importedName)) {
                context.report({
                  node: specifier,
                  messageId: "noDirectBlocker",
                  data: { name: importedName },
                });
              }
            }
          },
          MemberExpression(node) {
            if (
              !isIdentifier(node.object) ||
              !routerNamespaces.has(node.object.name)
            ) {
              return;
            }
            const name = staticMemberKey(node);
            if (name !== null && BLOCKER_EXPORTS.has(name)) {
              context.report({
                node,
                messageId: "noDirectBlocker",
                data: { name },
              });
            }
          },
          CallExpression(node) {
            if (staticMemberKey(node.callee) !== "addEventListener") {
              return;
            }
            if (staticStringValue(node.arguments.at(0)) === UNLOAD_EVENT) {
              context.report({ node, messageId: "noDirectUnloadListener" });
            }
          },
        };
      },
    },
  },
});
