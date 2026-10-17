// Confine table-locking SQL in the API's database modules to one owner.
//
// The online migration phase runs on a session with a one-second
// `lock_timeout`. A statement that waits for a table lock (an index build,
// drop or reindex, ALTER TABLE or ALTER INDEX, VALIDATE CONSTRAINT, LOCK
// TABLE, ANALYZE) can wait longer than that on a busy table, and run there
// directly it fails the migrate run. `apps/api/src/db/online-ddl.ts` builds
// each such statement as an opaque value that only its gate runs, deferring
// the phase instead. This rule keeps the SQL text out of every other module,
// so the type is the only way to write one:
//
//   - lock-taking SQL text in a string or template literal in
//     `apps/api/src/db/**` outside the owner. The value of a `createSql`
//     property is an index declaration the owner's builder validates and
//     reads, so it is exempt, and reading `createSql` anywhere else is the
//     violation instead;
//   - importing `createOnlineIndexGate` (only the owner opens the gate) or
//     `createUngatedTableGateForTests` (tests only, which this rule never
//     lints) outside the owner.
//
// Exempt by construction: tests and fixtures, which build their own tables;
// SQL migration files, which are not JavaScript; and
// `apps/api/src/db/migration-runner.ts`, the schema phase, whose only DDL is
// on drizzle's own ledger table, which no application session writes, inside
// a transaction with its own LOCAL lock budget.

import { eslintCompatPlugin, type Node } from "@oxlint/plugins";

import { canonicalModuleId } from "./module-id.ts";
import {
  getPropertyName,
  isAstNode,
  isTestFile,
  repoRelativeFilename,
  staticStringValue,
} from "./utils.ts";

const OWNER = "apps/api/src/db/online-ddl";
const DATABASE_MODULES = "apps/api/src/db/";
const SCHEMA_PHASE = "apps/api/src/db/migration-runner";
const DECLARED_BUILD = "createSql";
const GATE_OPENERS = new Set([
  "createOnlineIndexGate",
  "createUngatedTableGateForTests",
]);

// Multi-word keywords match in any case: prose rarely says "alter table".
// REINDEX and the maintenance verbs are uppercase-only, because "reindex" and
// "analyze" are ordinary words in messages.
const LOCK_TAKING_SQL = [
  /\bcreate\s+(?:unique\s+)?index\b/iu,
  /\bdrop\s+index\b/iu,
  /\bREINDEX\b/u,
  /\balter\s+(?:table|index)\b/iu,
  /\block\s+table\b/iu,
  /\bvalidate\s+constraint\b/iu,
  /^\s*(?:ANALYZE|VACUUM|CLUSTER)\b/u,
];

const SQL_COMMENT = /--[^\n]*|\/\*[\S\s]*?\*\//gu;

const quasiText = (quasi: unknown): string => {
  const value = isAstNode(quasi) ? quasi.value : undefined;
  return typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    typeof value.raw === "string"
    ? value.raw
    : "";
};

// A template literal's static chunks joined around a placeholder, so a
// keyword split by an interpolation (`ALTER TABLE ${t}`) still reads whole.
const literalText = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }
  if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
    return node.quasis.map((quasi) => quasiText(quasi)).join(" ? ");
  }
  return null;
};

const takesTableLock = (text: string): boolean => {
  const sql = text.replace(SQL_COMMENT, " ");
  return LOCK_TAKING_SQL.some((pattern) => pattern.test(sql));
};

const propertyKeyName = (property: unknown): string | null => {
  if (!isAstNode(property) || property.type !== "Property") {
    return null;
  }
  return property.computed === true
    ? staticStringValue(property.key)
    : getPropertyName(property.key);
};

// The value of an object literal's `createSql` property: a declaration.
const isDeclaredBuild = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const { parent } = node;
  return (
    isAstNode(parent) &&
    parent.type === "Property" &&
    parent.value === node &&
    isAstNode(parent.parent) &&
    parent.parent.type === "ObjectExpression" &&
    propertyKeyName(parent) === DECLARED_BUILD
  );
};

export default eslintCompatPlugin({
  meta: { name: "confine-online-ddl" },
  rules: {
    "confine-online-ddl": {
      meta: {
        type: "problem",
        messages: {
          lockTakingSql:
            "Build table-locking SQL (index builds and drops, ALTER TABLE/INDEX, VALIDATE CONSTRAINT, explicit table locks, ANALYZE) with the builders in apps/api/src/db/online-ddl.ts and run it through its gate: the online phase's session has a one-second lock budget, and only the gate defers a busy table instead of failing the migrate run.",
          declaredBuildRead:
            "Only apps/api/src/db/online-ddl.ts reads an index declaration's createSql; pass the declaration to createIndexConcurrently.",
          gateOpener:
            "Only apps/api/src/db/online-ddl.ts opens the online index gate, and only tests run table work ungated; use runGatedTableWork or the OnlineTableGate a repair receives.",
        },
        schema: [],
      },
      createOnce(context) {
        let checksSql = false;
        const reportSql = (node: Node) => {
          if (!checksSql || isDeclaredBuild(node)) {
            return;
          }
          const text = literalText(node);
          if (text !== null && takesTableLock(text)) {
            context.report({ node, messageId: "lockTakingSql" });
          }
        };
        return {
          before() {
            const filename = repoRelativeFilename(context);
            if (
              isTestFile(filename) ||
              filename.includes("/__fixtures__/") ||
              canonicalModuleId(filename, filename) === OWNER
            ) {
              return false;
            }
            checksSql =
              filename.startsWith(DATABASE_MODULES) &&
              canonicalModuleId(filename, filename) !== SCHEMA_PHASE;
            return true;
          },
          Literal(node) {
            reportSql(node);
          },
          TemplateLiteral(node) {
            reportSql(node);
          },
          MemberExpression(node) {
            const name = node.computed
              ? staticStringValue(node.property)
              : getPropertyName(node.property);
            if (name === DECLARED_BUILD) {
              context.report({ node, messageId: "declaredBuildRead" });
            }
          },
          Property(node) {
            if (
              node.parent.type === "ObjectPattern" &&
              propertyKeyName(node) === DECLARED_BUILD
            ) {
              context.report({ node, messageId: "declaredBuildRead" });
            }
          },
          ImportSpecifier(node) {
            const imported =
              node.imported.type === "Identifier"
                ? node.imported.name
                : node.imported.value;
            if (GATE_OPENERS.has(imported)) {
              context.report({ node, messageId: "gateOpener" });
            }
          },
        };
      },
    },
  },
});
