// Audit rows must be written through createAuditRecorder or
// createBackgroundAuditRecorder. Six maintenance paths inserted `auditLogs`
// directly and independently reconstructed derived columns, so otherwise
// equivalent events accumulated different grouping, execution, and category
// metadata.
//
// The ban is deliberately scoped to `.insert(auditLogs)`: other Drizzle
// inserts are unrelated, and a different identifier is not assumed to name
// the audit table. `apps/api/src/lib/audit-log.ts` is the sole owner of the
// physical insert. The `direct-audit-log-insert` ratchet metric covers simple
// textual variants the identifier-based AST rule cannot resolve.

type AstNode = { type: string } & Record<string, unknown>;

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
  report: (diagnostic: { node: unknown; messageId: "directInsert" }) => void;
};

const filenameForContext = (context: RuleContext) =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const isIdentifierNamed = (node: unknown, name: string): boolean =>
  isAstNode(node) && node.type === "Identifier" && node.name === name;

export default {
  meta: { name: "no-direct-audit-log-insert" },
  rules: {
    "no-direct-audit-log-insert": {
      meta: {
        type: "problem",
        messages: {
          directInsert:
            "Do not insert auditLogs directly. Use createAuditRecorder or " +
            "createBackgroundAuditRecorder so derived audit columns stay " +
            "consistent.",
        },
      },
      create(context: RuleContext) {
        const filename = filenameForContext(context);
        if (
          !filename.includes("apps/api/src/") &&
          !filename.endsWith(
            ".oxlint-plugins/__fixtures__/no-direct-audit-log-insert.fixture.ts",
          )
        ) {
          return {};
        }
        if (filename.endsWith("apps/api/src/lib/audit-log.ts")) {
          return {};
        }
        return {
          CallExpression(node: AstNode) {
            const callee = node.callee;
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              !isIdentifierNamed(callee.property, "insert") ||
              !Array.isArray(node.arguments) ||
              !isIdentifierNamed(node.arguments.at(0), "auditLogs")
            ) {
              return;
            }
            context.report({ node, messageId: "directInsert" });
          },
        };
      },
    },
  },
};
