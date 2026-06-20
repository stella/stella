// Ban direct React `useEffect` in app code.
//
// Most useEffect usage compensates for primitives React already gives you:
// derive state in render, handle the user event in a handler, fetch with a
// data-fetching library, or reset with `key`. The remaining external-system
// synchronization goes through the named wrappers `useMountEffect` /
// `useExternalSyncEffect` so intent is explicit and greppable.
//
// Full rationale + decision table live in the convention skill, referenced
// from the diagnostic so a failing call points the reader (or agent) at the
// source of truth: /conventions-use-effect.

import { getImportedName, isIdentifier } from "./utils.ts";

const REACT_MODULE = "react";

const filenameForContext = (context) =>
  context.filename ?? context.getFilename?.() ?? "";

const isAllowedFile = (context, allowedFiles) => {
  const filename = filenameForContext(context);
  return allowedFiles.some((allowedFile) => filename.endsWith(allowedFile));
};

export default {
  meta: { name: "no-raw-use-effect" },
  rules: {
    "no-raw-use-effect": {
      meta: {
        type: "problem",
        messages: {
          noRawUseEffect:
            "Direct useEffect is banned. Most effects are unnecessary: derive state in render, do the work in the event handler, fetch with TanStack Query, or reset with `key`. For genuine external-system sync use useMountEffect or useExternalSyncEffect from @/hooks/use-effect. See the convention: /conventions-use-effect.",
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

        // Local names bound to React's `useEffect` (named import, possibly
        // aliased) and React namespace bindings (default or `* as React`).
        // Tracking the import keeps the rule from firing on an unrelated
        // local helper that happens to be named `useEffect`.
        const useEffectAliases = new Set();
        const reactNamespaces = new Set();

        return {
          ImportDeclaration(node) {
            if (node.source?.value !== REACT_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportDefaultSpecifier" ||
                specifier.type === "ImportNamespaceSpecifier"
              ) {
                reactNamespaces.add(specifier.local.name);
                continue;
              }
              if (
                specifier.type === "ImportSpecifier" &&
                getImportedName(specifier) === "useEffect"
              ) {
                useEffectAliases.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            const callee = node.callee;

            // `useEffect(...)` via a (possibly aliased) named import.
            if (isIdentifier(callee) && useEffectAliases.has(callee.name)) {
              context.report({ node, messageId: "noRawUseEffect" });
              return;
            }

            // `React.useEffect(...)` via a namespace or default import.
            if (
              callee.type === "MemberExpression" &&
              callee.computed === false &&
              isIdentifier(callee.object) &&
              reactNamespaces.has(callee.object.name) &&
              isIdentifier(callee.property, "useEffect")
            ) {
              context.report({ node, messageId: "noRawUseEffect" });
            }
          },
        };
      },
    },
  },
};
