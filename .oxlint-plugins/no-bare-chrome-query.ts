// Ban bare `useQuery` in persistent chrome (the layout shell, sidebar,
// inspector, AI-key gate) that mounts on every route.
//
// On a cold cache, a `useQuery` started during the first render resolves and
// notifies the still-mounting fiber, which React reports as "Can't perform a
// React state update on a component that hasn't mounted yet" — a dev-only
// warning the route-smoke e2e treats as a failure, and a recurring family of
// cold-start flakes. `useChromeQuery` (apps/web/src/hooks/use-chrome-query.ts)
// returns cached data synchronously but defers the network fetch until after
// mount, so the warning is structurally impossible.
//
// Scope this rule with `overrides.files` in oxlint.config.ts for chrome
// modules; route/page content stays free to use `useQuery` with loader-backed
// cache guarantees.

import { getImportedName, isIdentifier } from "./utils.ts";

const QUERY_MODULE = "@tanstack/react-query";

const filenameForContext = (context) =>
  context.filename ?? context.getFilename?.() ?? "";

const isAllowedFile = (context, allowedFiles) => {
  const filename = filenameForContext(context).replace(/\\/g, "/");
  return allowedFiles.some((allowedFile) => filename.endsWith(allowedFile));
};

export default {
  meta: { name: "no-bare-chrome-query" },
  rules: {
    "no-bare-chrome-query": {
      meta: {
        type: "problem",
        messages: {
          noBareChromeQuery:
            "Persistent chrome must not call useQuery directly: a cold-cache fetch resolving mid-mount triggers React's \"state update on a component that hasn't mounted yet\" warning. Use useChromeQuery from @/hooks/use-chrome-query, which defers the fetch until after mount.",
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
      create(context) {
        const options = context.options?.[0] ?? {};
        const allowedFiles = Array.isArray(options.allowedFiles)
          ? options.allowedFiles
          : [];

        if (isAllowedFile(context, allowedFiles)) {
          return {};
        }

        const queryAliases = new Set();
        const queryNamespaces = new Set();

        return {
          ImportDeclaration(node) {
            if (node.source?.value !== QUERY_MODULE) {
              return;
            }

            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportNamespaceSpecifier") {
                queryNamespaces.add(specifier.local.name);
                continue;
              }
              if (
                specifier.type === "ImportSpecifier" &&
                getImportedName(specifier) === "useQuery"
              ) {
                queryAliases.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            const callee = node.callee;

            if (isIdentifier(callee) && queryAliases.has(callee.name)) {
              context.report({ node, messageId: "noBareChromeQuery" });
              return;
            }

            if (
              callee.type === "MemberExpression" &&
              callee.computed === false &&
              isIdentifier(callee.object) &&
              queryNamespaces.has(callee.object.name) &&
              isIdentifier(callee.property, "useQuery")
            ) {
              context.report({ node, messageId: "noBareChromeQuery" });
            }
          },
        };
      },
    },
  },
};
