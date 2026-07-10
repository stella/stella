// Ban bare `String.prototype.localeCompare` in application code.
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
//   apps/web -> getCollator / compareByLocale from @/lib/collation
//   apps/api -> getCollator / compareByLocale from @/api/lib/collation
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

import { getPropertyName } from "./utils.ts";

const filenameForContext = (context) =>
  context.filename ?? context.getFilename?.() ?? "";

const isAllowedFile = (context, allowedFiles) => {
  const filename = filenameForContext(context);
  return allowedFiles.some((allowedFile) => filename.endsWith(allowedFile));
};

export default {
  meta: { name: "require-cached-collator" },
  rules: {
    "require-cached-collator": {
      meta: {
        type: "problem",
        messages: {
          requireCachedCollator:
            "Bare localeCompare ignores the app locale and rebuilds collation data per call. Use getCollator(locale)/compareByLocale(locale) from the shared collation helper, or disable inline with a reason when comparing non-linguistic keys (ids, paths).",
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

        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              callee.computed !== false
            ) {
              return;
            }
            if (getPropertyName(callee.property) !== "localeCompare") {
              return;
            }
            context.report({ node, messageId: "requireCachedCollator" });
          },
        };
      },
    },
  },
};
