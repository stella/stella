// Audit rows must be written through createAuditRecorder or
// createBackgroundAuditRecorder. Six maintenance paths inserted `auditLogs`
// directly and independently reconstructed derived columns, so otherwise
// equivalent events accumulated different grouping, execution, and category
// metadata.
//
// The ban is deliberately scoped to `.insert(auditLogs)` and aliases imported
// from the canonical schema module: other Drizzle inserts are unrelated, and
// an arbitrary local identifier is not assumed to name the audit table.
// `apps/api/src/lib/audit-log.ts` is the sole owner of the physical insert. The
// `direct-audit-log-insert` ratchet metric covers the same imported aliases.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const isIdentifierNamed = (node: unknown, name: string): boolean =>
  isIdentifier(node, name);

export default eslintCompatPlugin({
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
      createOnce(context) {
        const auditLogBindings = new Set(["auditLogs"]);
        return {
          before() {
            auditLogBindings.clear();
            auditLogBindings.add("auditLogs");
            const filename = filenameForContext(context);
            return (
              (filename.includes("apps/api/src/") ||
                filename.endsWith(
                  ".oxlint-plugins/__fixtures__/no-direct-audit-log-insert.fixture.ts",
                )) &&
              !filename.endsWith("apps/api/src/lib/audit-log.ts")
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              node.source.value !== "@/api/db/schema" ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (getImportedName(specifier) !== "auditLogs") {
                continue;
              }
              const localName = getImportLocalName(specifier);
              if (localName !== null) {
                auditLogBindings.add(localName);
              }
            }
          },
          CallExpression(node) {
            const callee = node.callee;
            const firstArgument = node.arguments.at(0);
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              !isIdentifierNamed(callee.property, "insert") ||
              !isIdentifier(firstArgument) ||
              !auditLogBindings.has(firstArgument.name)
            ) {
              return;
            }
            context.report({ node, messageId: "directInsert" });
          },
        };
      },
    },
  },
});
