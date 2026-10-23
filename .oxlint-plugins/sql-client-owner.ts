// Bun 1.4.4 decodes every Postgres int8 as a string unless the client is
// constructed with `bigint: true`, and drizzle's bun-sql factory sets that
// option after construction, where it no longer takes effect. Clients and
// their drizzle databases are therefore built only by the owner, which sets it
// and registers int8 codecs.
//
// Fail closed: every value use of Bun's `SQL` (named, namespace or the
// `Bun.SQL` global) is reported except reading a member (`SQL.PostgresError`),
// an `instanceof` check and type positions; every use of drizzle's bun-sql
// `drizzle` (calls, `drizzle.mock`, aliases, re-exports) is reported.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  canonicalModuleId,
  isAstNode,
  isIdentifierReference,
  memberPropertyName,
  repoRelativeFilename,
  resolveImport,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const SQL_CLIENT_OWNER = "apps/api/src/db/sql-client";

const isDrizzleBunSql = (moduleId: string): boolean =>
  moduleId === "drizzle-orm/bun-sql" ||
  moduleId.startsWith("drizzle-orm/bun-sql/");

type Restricted = "bun-sql" | "drizzle";

const restrictedExport = (
  moduleId: string,
  imported: string,
): Restricted | null => {
  if (moduleId === "bun" && imported === "SQL") {
    return "bun-sql";
  }
  if (isDrizzleBunSql(moduleId) && imported === "drizzle") {
    return "drizzle";
  }
  return null;
};

const IMPORT_SPECIFIERS = new Set([
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
]);

// Whether `node` (an expression evaluating to a restricted export) is used in
// a shape that cannot construct a client.
const isPermittedUse = (node: AstNode, kind: Restricted): boolean => {
  const parent: unknown = node.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (parent.type.startsWith("TS") && parent.type !== "TSAsExpression") {
    return true;
  }
  if (kind === "drizzle") {
    return false;
  }
  return (
    (parent.type === "MemberExpression" && parent.object === node) ||
    (parent.type === "BinaryExpression" &&
      parent.operator === "instanceof" &&
      parent.right === node)
  );
};

export default eslintCompatPlugin({
  meta: { name: "sql-client-owner" },
  rules: {
    "sql-client-owner": {
      meta: {
        type: "problem",
        messages: {
          sqlClientOwner:
            "Build Bun SQL clients with createSqlClient and drizzle databases with createDatabase or createMockDatabase from apps/api/src/db/sql-client.ts; they decode int8 as BigInt or a checked Number instead of a string.",
        },
        schema: [],
      },
      createOnce(context) {
        const report = (node: AstNode) => {
          context.report({ node, messageId: "sqlClientOwner" });
        };
        return {
          before() {
            const filename = repoRelativeFilename(context);
            return canonicalModuleId(filename, filename) !== SQL_CLIENT_OWNER;
          },
          ImportDeclaration(node) {
            if (node.importKind === "type") {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                !IMPORT_SPECIFIERS.has(specifier.type) ||
                ("importKind" in specifier && specifier.importKind === "type")
              ) {
                continue;
              }
              const binding = resolveImport(context, specifier.local);
              const kind =
                binding === null
                  ? null
                  : restrictedExport(binding.moduleId, binding.imported);
              // Imports bind in the declaration's (module) scope.
              const variable =
                kind === null
                  ? null
                  : (context.sourceCode
                      .getScope(node)
                      .set.get(specifier.local.name) ?? null);
              if (kind === null || variable === null) {
                continue;
              }
              for (const reference of variable.references) {
                const identifier: unknown = reference.identifier;
                if (
                  isAstNode(identifier) &&
                  !isPermittedUse(identifier, kind)
                ) {
                  report(identifier);
                }
              }
            }
          },
          MemberExpression(member) {
            const node = unwrapExpression(member);
            if (node === null) {
              return;
            }
            if (
              memberPropertyName(node) !== "SQL" &&
              memberPropertyName(node) !== "drizzle"
            ) {
              return;
            }
            const object = unwrapExpression(node.object);
            const globalBunSql =
              memberPropertyName(node) === "SQL" &&
              isIdentifierReference(object) &&
              object.name === "Bun" &&
              resolveVariable(context, object) === null;
            const binding = globalBunSql ? null : resolveImport(context, node);
            const kind = globalBunSql
              ? "bun-sql"
              : binding === null
                ? null
                : restrictedExport(binding.moduleId, binding.imported);
            if (kind !== null && !isPermittedUse(node, kind)) {
              report(node);
            }
          },
        };
      },
    },
  },
});
