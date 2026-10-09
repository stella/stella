import { eslintCompatPlugin } from "@oxlint/plugins";
// Ban direct collation construction and `String.prototype.localeCompare`.
//
// `"a".localeCompare("b")` without an explicit locale sorts with the
// runtime's default locale: correct-looking on a developer's machine, wrong
// (or merely different) in CI/prod, and silently wrong for e.g. Czech/Slovak,
// where "ch" collates as its own letter sorted after "h" only under a
// cs/sk-aware collation. Building a fresh collation table inside a `.sort()`
// callback (`.sort((a, b) => a.name.localeCompare(b.name, locale))`) also
// reconstructs ICU tailoring data on every pairwise comparison instead of
// once for the whole sort.
//
// Route through the shared collation helper instead, which caches one
// `Intl.Collator` per locale:
//   getCollator / compareByLocale from @stll/collation
//
// Not every `.localeCompare(` call sorts display text — comparing opaque
// ids, file paths, or other non-linguistic keys for a deterministic (not
// locale-sensitive) order is a legitimate, narrow exception. Disable inline
// with a reason in that case; do not route ids through the collator.
//
// Flagged:
//   a.name.localeCompare(b.name)
//   a.name.localeCompare(b.name, locale)
//
// Allowed (only inside the collation helper itself, which owns the one
// legitimate bare call building the cached collator):
//   collator.compare(a, b)

import { getPropertyName, isFileIn } from "./utils.ts";

export default eslintCompatPlugin({
  meta: { name: "require-cached-collator" },
  rules: {
    "require-cached-collator": {
      meta: {
        type: "problem",
        messages: {
          requireCachedCollator:
            "Direct string collation bypasses the shared cache. Use getCollator/compareByLocale for display text or compareCodeUnit for technical keys from @stll/collation.",
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
        let enabled = true;

        return {
          before() {
            const options: unknown = context.options[0];
            const configuredFiles =
              typeof options === "object" &&
              options !== null &&
              !Array.isArray(options)
                ? Reflect.get(options, "allowedFiles")
                : undefined;
            const allowedFiles = Array.isArray(configuredFiles)
              ? configuredFiles.filter(
                  (file): file is string => typeof file === "string",
                )
              : [];
            enabled = !isFileIn(context, allowedFiles);
            return enabled;
          },
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== "MemberExpression" || callee.computed) {
              return;
            }
            const propertyName = getPropertyName(callee.property);
            if (propertyName === "localeCompare") {
              context.report({ node, messageId: "requireCachedCollator" });
              return;
            }
            if (
              propertyName === "Collator" &&
              callee.object.type === "Identifier" &&
              callee.object.name === "Intl"
            ) {
              context.report({ node, messageId: "requireCachedCollator" });
            }
          },
          NewExpression(node) {
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              callee.computed ||
              callee.object.type !== "Identifier" ||
              callee.object.name !== "Intl" ||
              getPropertyName(callee.property) !== "Collator"
            ) {
              return;
            }
            context.report({ node, messageId: "requireCachedCollator" });
          },
        };
      },
    },
  },
});
