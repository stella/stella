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

import type { AstNode } from "./utils.ts";
import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
  report: (diagnostic: { node: unknown; messageId: "directInsert" }) => void;
};

const isIdentifierNamed = (node: unknown, name: string): boolean =>
  isIdentifier(node, name);

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
        const auditLogBindings = new Set(["auditLogs"]);
        return {
          ImportDeclaration(node: AstNode) {
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
          CallExpression(node: AstNode) {
            const callee = node.callee;
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              !isIdentifierNamed(callee.property, "insert") ||
              !Array.isArray(node.arguments) ||
              !isIdentifier(node.arguments.at(0)) ||
              !auditLogBindings.has(node.arguments[0].name)
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
