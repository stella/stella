// Enforce stella's single toast integration surface.
//
// Product code should use `stellaToast` from `@stll/ui/toast`.
// That wrapper applies default timeouts and keeps app code away from
// raw Base UI toast managers.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getImportedName } from "./utils.ts";

// The grouped alias (@stll/ui/components/toast) is deprecated but still
// resolves to this module, so both spellings are the toast entry point.
const STELLA_TOAST_MODULES: readonly string[] = [
  "@stll/ui/toast",
  "@stll/ui/components/toast",
];
const RAW_TOAST_MODULE = "@base-ui/react/toast";

const DISALLOWED_STELLA_IMPORTS = new Set([
  "AnchoredToastProvider",
  "anchoredToastManager",
  "toast",
  "toastManager",
]);

export default eslintCompatPlugin({
  meta: { name: "stella-toast" },
  rules: {
    "stella-toast": {
      meta: {
        type: "problem",
        messages: {
          rawToast:
            "Use `stellaToast` from `@stll/ui/toast` instead of raw Base UI toast APIs.",
          restrictedStellaImport:
            "Use `stellaToast` from `@stll/ui/toast`; `{{name}}` bypasses stella toast guarantees.",
        },
      },
      createOnce(context) {
        return {
          ImportDeclaration(node) {
            if (typeof node.source.value !== "string") {
              return;
            }

            if (node.source.value === RAW_TOAST_MODULE) {
              context.report({ node, messageId: "rawToast" });
              return;
            }

            if (!STELLA_TOAST_MODULES.includes(node.source.value)) {
              return;
            }

            for (const specifier of node.specifiers) {
              const name = getImportedName(specifier);
              if (name === null || !DISALLOWED_STELLA_IMPORTS.has(name)) {
                continue;
              }

              context.report({
                node: specifier,
                messageId: "restrictedStellaImport",
                data: { name },
              });
            }
          },
        };
      },
    },
  },
});
