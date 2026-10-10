// Prevent broad application facades from returning after their consumers were
// migrated to explicit leaf modules. These aliases hide side effects, obscure
// ownership, and turn small leaf changes into high-fanout dependency edges.

import { eslintCompatPlugin, type Context, type Node } from "@oxlint/plugins";

import { canonicalModuleId } from "./module-id.ts";
import { repoRelativeFilename } from "./utils.ts";

const MANAGED_NAMESPACES = ["@/api/db", "@/api/lib/analytics", "@/lib/errors"];
const REMOVED_AST_FACADE_MODULE_IDS = new Set([
  "apps/api/src/handlers/case-law/document-ast",
  "apps/api/src/lib/case-law/document-ast",
]);

const ALLOWED_LEAF_IMPORTS = new Set([
  "@/api/db/agent-auth-schema",
  "@/api/db/auth-schema",
  "@/api/db/backfill-runtime",
  "@/api/db/billing-validators",
  "@/api/db/columns",
  "@/api/db/corpus-schema-lane",
  "@/api/db/currency-exponents",
  "@/api/db/database-relations",
  "@/api/db/entity-feature-coverage",
  "@/api/db/entity-feature-gate-metadata",
  "@/api/db/entity-feature-policies",
  "@/api/db/json-utils",
  "@/api/db/long-running-connection",
  "@/api/db/rls",
  "@/api/db/root",
  "@/api/db/registration-budget-schema",
  "@/api/db/retention",
  "@/api/db/safe-db",
  "@/api/db/schema",
  "@/api/db/schema/desktop-device-proof-replay",
  "@/api/db/schema-validators",
  "@/api/db/scoped",
  "@/api/db/scoped-feature-access",
  "@/api/db/shared-pool-connection-settings",
  "@/api/db/shared-pool-timeout-policy",
  "@/api/db/shared-pool-timeouts",
  "@/api/lib/analytics/capture",
  "@/api/lib/analytics/client",
  "@/api/lib/analytics/server-analytics",
  "@/api/lib/analytics/tanstack-ai",
  "@/lib/errors/action-admission",
  "@/lib/errors/action-admission-response",
  "@/lib/errors/api",
  "@/lib/errors/api-tag",
  "@/lib/errors/auth",
  "@/lib/errors/client",
  "@/lib/errors/localization",
  "@/lib/errors/query-result",
  "@/lib/errors/telemetry",
  "@/lib/errors/user-safe",
  "@/lib/errors/user-toast",
]);

const isManagedSpecifier = (specifier: string): boolean =>
  MANAGED_NAMESPACES.some(
    (namespace) =>
      specifier === namespace || specifier.startsWith(`${namespace}/`),
  );

const isRemovedAstFacade = (context: Context, specifier: string): boolean =>
  REMOVED_AST_FACADE_MODULE_IDS.has(
    canonicalModuleId(specifier, repoRelativeFilename(context)),
  );

const reportRemovedAstFacade = (
  context: Context,
  source: Node | null,
  specifier: string | undefined,
): boolean => {
  if (
    source === null ||
    specifier === undefined ||
    !isRemovedAstFacade(context, specifier)
  ) {
    return false;
  }
  context.report({
    node: source,
    messageId: "removedAstFacade",
    data: { specifier },
  });
  return true;
};

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

type ReportInvalidImportOptions = {
  context: Context;
  source: Node | null;
  kind: "import" | "reexport";
};

const reportInvalidImport = ({
  context,
  source,
  kind,
}: ReportInvalidImportOptions): void => {
  const specifier = stringLiteralValue(source);
  if (reportRemovedAstFacade(context, source, specifier)) {
    return;
  }
  if (
    source === null ||
    specifier === undefined ||
    !isManagedSpecifier(specifier) ||
    (kind === "import" && ALLOWED_LEAF_IMPORTS.has(specifier))
  ) {
    return;
  }
  context.report({
    node: source,
    messageId: kind === "reexport" ? "leafReexport" : "facadeImport",
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
          removedAstFacade:
            "Import @stll/legal-ast/document-ast directly; {{specifier}} is a removed API facade.",
          leafReexport:
            "Do not re-export {{specifier}}; consumers must import its owning leaf directly.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          ImportDeclaration(node) {
            reportInvalidImport({
              context,
              source: node.source,
              kind: "import",
            });
          },
          ExportAllDeclaration(node) {
            reportInvalidImport({
              context,
              source: node.source,
              kind: "reexport",
            });
          },
          ExportNamedDeclaration(node) {
            reportInvalidImport({
              context,
              source: node.source,
              kind: "reexport",
            });
          },
          TSExternalModuleReference(node) {
            reportInvalidImport({
              context,
              source: node.expression,
              kind: "import",
            });
          },
          TSImportType(node) {
            reportInvalidImport({
              context,
              source: node.source,
              kind: "import",
            });
          },
          ImportExpression(node) {
            reportInvalidImport({
              context,
              source: node.source,
              kind: "import",
            });
          },
        };
      },
    },
  },
});
