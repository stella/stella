// Ban `useSuspenseQuery` in shared chrome.
//
// `useSuspenseQuery` is appropriate in route/page content where the route
// loader has already guaranteed the query or a local Suspense boundary owns
// the pending state. In persistent chrome, a cache miss suspends too much UI.
// Scope this rule with `overrides.files` in oxlint.config.ts for chrome
// modules; route content stays free to use Suspense deliberately.

import { getImportedName, isIdentifier } from "./utils.ts";

const QUERY_MODULE = "@tanstack/react-query";

const filenameForContext = (context) =>
  context.filename ?? context.getFilename?.() ?? "";

const isAllowedFile = (context, allowedFiles) => {
  const filename = filenameForContext(context);
  return allowedFiles.some((allowedFile) => filename.endsWith(allowedFile));
};

export default {
  meta: { name: "no-shared-suspense-query" },
  rules: {
    "no-shared-suspense-query": {
      meta: {
        type: "problem",
        messages: {
          noSharedSuspenseQuery:
            "Shared chrome must not call useSuspenseQuery: a cache miss can suspend persistent UI. Use useQuery with an explicit loading/disabled state, or move the Suspense query into route/page content with a loader-backed cache guarantee.",
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

        const suspenseQueryAliases = new Set();
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
                getImportedName(specifier) === "useSuspenseQuery"
              ) {
                suspenseQueryAliases.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            const callee = node.callee;

            if (isIdentifier(callee) && suspenseQueryAliases.has(callee.name)) {
              context.report({ node, messageId: "noSharedSuspenseQuery" });
              return;
            }

            if (
              callee.type === "MemberExpression" &&
              callee.computed === false &&
              isIdentifier(callee.object) &&
              queryNamespaces.has(callee.object.name) &&
              isIdentifier(callee.property, "useSuspenseQuery")
            ) {
              context.report({ node, messageId: "noSharedSuspenseQuery" });
            }
          },
        };
      },
    },
  },
};
