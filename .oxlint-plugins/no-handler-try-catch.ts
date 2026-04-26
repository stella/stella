// Discourage try/catch as expected control flow in safe API handler modules.
//
// Safe handlers already translate Result errors and unexpected throws at the
// framework boundary. Expected application failures should be represented as
// Result errors or typed return values, not local catch branches.
//
// This rule intentionally applies only to modules that import createSafeHandler
// or createSafeRootHandler. Integration adapters, parsers, scripts, workers, and
// other boundary code may still need try/catch legitimately.

const SAFE_HANDLER_IMPORT = "@/api/lib/api-handlers";
const SAFE_HANDLER_FACTORIES = new Set([
  "createSafeHandler",
  "createSafeRootHandler",
]);

const getImportName = (node) => {
  if (typeof node?.name === "string") {
    return node.name;
  }
  if (typeof node?.value === "string") {
    return node.value;
  }
  return null;
};

export default {
  meta: { name: "no-handler-try-catch" },
  rules: {
    "no-handler-try-catch": {
      meta: {
        type: "problem",
        messages: {
          tryCatch:
            "Avoid try/catch for expected API handler flow. " +
            "Return Result errors or typed values from the failable boundary; " +
            "leave unexpected exception capture to createSafeHandler.",
        },
      },
      create(context) {
        let importsSafeHandler = false;

        return {
          ImportDeclaration(node) {
            if (node.source.value !== SAFE_HANDLER_IMPORT) {
              return;
            }

            importsSafeHandler =
              importsSafeHandler ||
              node.specifiers.some((specifier) => {
                if (specifier.type !== "ImportSpecifier") {
                  return false;
                }

                const importedName = getImportName(specifier.imported);
                return (
                  importedName !== null &&
                  SAFE_HANDLER_FACTORIES.has(importedName)
                );
              });
          },

          TryStatement(node) {
            if (!importsSafeHandler) {
              return;
            }

            context.report({
              node,
              messageId: "tryCatch",
            });
          },
        };
      },
    },
  },
};
