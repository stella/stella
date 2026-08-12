// Prevent broad application facades from returning after their consumers were
// migrated to explicit leaf modules. These aliases hide side effects, obscure
// ownership, and turn small leaf changes into high-fanout dependency edges.

import { eslintCompatPlugin, type Context, type Node } from "@oxlint/plugins";

const MANAGED_NAMESPACES = ["@/api/db", "@/api/lib/analytics", "@/lib/errors"];

const ALLOWED_LEAF_IMPORTS = new Set([
  "@/api/db/agent-auth-schema",
  "@/api/db/auth-schema",
  "@/api/db/billing-validators",
  "@/api/db/columns",
  "@/api/db/database-relations",
  "@/api/db/json-utils",
  "@/api/db/rls",
  "@/api/db/root",
  "@/api/db/safe-db",
  "@/api/db/schema",
  "@/api/db/schema-validators",
  "@/api/db/scoped",
  "@/api/lib/analytics/capture",
  "@/api/lib/analytics/client",
  "@/api/lib/analytics/config",
  "@/api/lib/analytics/tanstack-ai",
  "@/api/lib/analytics/types",
  "@/lib/errors/api",
  "@/lib/errors/auth",
  "@/lib/errors/client",
  "@/lib/errors/localization",
  "@/lib/errors/telemetry",
  "@/lib/errors/user-safe",
  "@/lib/errors/utils",
]);

const isManagedSpecifier = (specifier: string): boolean =>
  MANAGED_NAMESPACES.some(
    (namespace) =>
      specifier === namespace || specifier.startsWith(`${namespace}/`),
  );

const stringLiteralValue = (node: unknown): string | undefined => {
  if (
    typeof node !== "object" ||
    node === null ||
    !("type" in node) ||
    !("value" in node)
  ) {
    return undefined;
  }
  if (
    (node.type !== "Literal" && node.type !== "StringLiteral") ||
    typeof node.value !== "string"
  ) {
    return undefined;
  }
  return node.value;
};

const reportInvalidImport = (context: Context, source: Node | null): void => {
  const specifier = stringLiteralValue(source);
  if (
    source === null ||
    specifier === undefined ||
    !isManagedSpecifier(specifier) ||
    ALLOWED_LEAF_IMPORTS.has(specifier)
  ) {
    return;
  }
  context.report({
    node: source,
    messageId: "facadeImport",
    data: { specifier },
  });
};

const reportLeafReexport = (context: Context, source: Node | null): void => {
  const specifier = stringLiteralValue(source);
  if (
    source === null ||
    specifier === undefined ||
    !isManagedSpecifier(specifier)
  ) {
    return;
  }
  context.report({
    node: source,
    messageId: "leafReexport",
    data: { specifier },
  });
};

export default eslintCompatPlugin({
  meta: { name: "no-facade-imports" },
  rules: {
    "no-facade-imports": {
      meta: {
        type: "problem",
        messages: {
          facadeImport:
            "Import an approved owning leaf instead of {{specifier}}.",
          leafReexport:
            "Do not re-export {{specifier}}; consumers must import its owning leaf directly.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          ImportDeclaration(node) {
            reportInvalidImport(context, node.source);
          },
          ExportAllDeclaration(node) {
            reportLeafReexport(context, node.source);
          },
          ExportNamedDeclaration(node) {
            reportLeafReexport(context, node.source);
          },
          ImportExpression(node) {
            reportInvalidImport(context, node.source);
          },
        };
      },
    },
  },
});
