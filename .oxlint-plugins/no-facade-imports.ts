// Prevent broad application facades from returning after their consumers were
// migrated to explicit leaf modules. These aliases hide side effects, obscure
// ownership, and turn small leaf changes into high-fanout dependency edges.

type AstNode = { type: string } & Record<string, unknown>;

type RuleContext = {
  report: (diagnostic: {
    node: unknown;
    messageId: "facadeImport" | "leafReexport";
    data: { specifier: string };
  }) => void;
};

const MANAGED_NAMESPACES = ["@/api/db", "@/api/lib/analytics", "@/lib/errors"];

const ALLOWED_LEAF_IMPORTS = new Set([
  "@/api/db/auth-schema",
  "@/api/db/billing-validators",
  "@/api/db/columns",
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

const reportInvalidImport = (context: RuleContext, source: unknown): void => {
  const specifier = stringLiteralValue(source);
  if (
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

const reportLeafReexport = (context: RuleContext, source: unknown): void => {
  const specifier = stringLiteralValue(source);
  if (specifier === undefined || !isManagedSpecifier(specifier)) {
    return;
  }
  context.report({
    node: source,
    messageId: "leafReexport",
    data: { specifier },
  });
};

export default {
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
      create(context: RuleContext) {
        return {
          ImportDeclaration(node: AstNode) {
            reportInvalidImport(context, node.source);
          },
          ExportAllDeclaration(node: AstNode) {
            reportLeafReexport(context, node.source);
          },
          ExportNamedDeclaration(node: AstNode) {
            reportLeafReexport(context, node.source);
          },
          ImportExpression(node: AstNode) {
            reportInvalidImport(context, node.source);
          },
        };
      },
    },
  },
};
