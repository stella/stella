import { eslintCompatPlugin } from "@oxlint/plugins";

import { getImportedName, isFileIn } from "./utils.ts";

const HOTKEY_MODULES = new Set([
  "@tanstack/hotkeys",
  "@tanstack/react-hotkeys",
]);

// useFormatForDisplay() formats with the provider's platform, detected in the
// browser, so it is as ambient as detectPlatform().
const AMBIENT_EXPORTS = new Set([
  "detectPlatform",
  "formatForDisplay",
  "useFormatForDisplay",
]);

const ALLOWED_FILES = [
  "apps/web/src/lib/hotkeys.ts",
  "apps/web/src/hooks/use-hydration-safe-hotkey-platform.ts",
];

export default eslintCompatPlugin({
  meta: { name: "no-ambient-hotkey-format" },
  rules: {
    "no-ambient-hotkey-format": {
      meta: {
        type: "problem",
        messages: {
          ambientHotkeyFormat:
            "Ambient hotkey platform reads can differ between SSR and hydration. Use useHydrationSafeHotkeyPlatform() with formatHotkeyForPlatform().",
        },
      },
      createOnce(context) {
        return {
          before() {
            return !isFileIn(context, ALLOWED_FILES);
          },
          ImportDeclaration(node) {
            if (!HOTKEY_MODULES.has(node.source.value)) {
              return;
            }

            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportNamespaceSpecifier") {
                context.report({
                  node: specifier,
                  messageId: "ambientHotkeyFormat",
                });
                continue;
              }

              if (specifier.type !== "ImportSpecifier") {
                continue;
              }

              const importedName = getImportedName(specifier);
              if (importedName !== null && AMBIENT_EXPORTS.has(importedName)) {
                context.report({
                  node: specifier,
                  messageId: "ambientHotkeyFormat",
                });
              }
            }
          },
        };
      },
    },
  },
});
