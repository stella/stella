// Confine table-locking SQL in the API's database modules to one owner.
//
// The online migration phase runs on a session with a one-second
// `lock_timeout`. A statement that waits for a table lock (an index build,
// drop or reindex, ALTER TABLE or ALTER INDEX, policy and row-level security
// DDL, VALIDATE CONSTRAINT, LOCK TABLE, ANALYZE, or a declared DDL function) can wait longer than that on a busy table, and run there
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

import { DDL_FUNCTION_NAMES } from "../apps/api/src/db/online-ddl-functions.ts";
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
const FIXTURE = ".oxlint-plugins/__fixtures__/confine-online-ddl.fixture.ts";
const PLANTED_MODULE = "apps/api/src/db/planted-repair.ts";
const GATE_OPENERS = new Set([
  "createOnlineIndexGate",
  "createUngatedTableGateForTests",
]);

// Multi-word keywords match in any case: prose rarely says "alter table".
// "reindex" and the maintenance verbs are ordinary words in messages, so in
// lowercase they match only in a statement's shape: REINDEX followed by its
// object kind, a maintenance verb followed by a table or nothing at all.
const LOCK_TAKING_SQL = [
  /\bcreate\s+(?:unique\s+)?index\b/iu,
  /\bdrop\s+index\b/iu,
  /\bREINDEX\b/u,
  /\breindex\s+(?:\([^)]*\)\s*)?(?:index|table|schema|database|system)\b/iu,
  /\balter\s+(?:table|index)\b/iu,
  /\block\s+table\b/iu,
  /\b(?:create|alter|drop)\s+policy\b/iu,
  /\b(?:enable|force)\s+row\s+level\s+security\b/iu,
  /\bvalidate\s+constraint\b/iu,
  /^\s*(?:ANALYZE|VACUUM|CLUSTER)\b/u,
  /^\s*(?:analyze|vacuum|cluster)(?: +verbose)?(?:$|;| +(?:public\.|"|\?|[a-z_]\w*(?:$|;|\()))/iu,
  // A call to a function whose body runs table-locking DDL the type cannot see.
  ...(DDL_FUNCTION_NAMES.length === 0
    ? []
    : [new RegExp(`\\b(?:${DDL_FUNCTION_NAMES.join("|")})\\s*\\(`, "u")]),
];

const SQL_COMMENT = /--[^\n]*|\/\*[\S\s]*?\*\//gu;

// The text the template produces (`cooked`), so an escaped newline reads as
// one; `raw` only where a tagged template's escape leaves no cooked text.
const quasiText = (quasi: unknown): string => {
  const value = isAstNode(quasi) ? quasi.value : undefined;
  if (typeof value !== "object" || value === null) {
    return "";
  }
  if ("cooked" in value && typeof value.cooked === "string") {
    return value.cooked;
  }
  return "raw" in value && typeof value.raw === "string" ? value.raw : "";
};

// A template literal's static chunks joined around each interpolation: its
// static string value when it has one (`ALTER ${"TABLE"} t`), else a
// placeholder, so a keyword split by an interpolation still reads whole.
const literalText = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }
  if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    return node.quasis
      .map((quasi, offset) => {
        if (offset === 0) {
          return quasiText(quasi);
        }
        const expression: unknown = expressions[offset - 1];
        return `${staticStringValue(expression) ?? " ? "}${quasiText(quasi)}`;
      })
      .join("");
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
            "Build table-locking SQL (index builds and drops, ALTER TABLE/INDEX, policy and row-level security DDL, VALIDATE CONSTRAINT, explicit table locks, ANALYZE, calls to the functions declared in online-ddl-functions.ts) with the builders in apps/api/src/db/online-ddl.ts and run it through its gate: the online phase's session has a one-second lock budget, and only the gate defers a busy table instead of failing the migrate run.",
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
            const linted = repoRelativeFilename(context);
            // The regression fixture is linted as the database module it plants.
            const filename = linted === FIXTURE ? PLANTED_MODULE : linted;
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
            // `gate.createOnlineIndexGate(...)` through a namespace import.
            if (name !== null && GATE_OPENERS.has(name)) {
              context.report({ node, messageId: "gateOpener" });
            }
          },
          Property(node) {
            if (node.parent.type !== "ObjectPattern") {
              return;
            }
            const key = propertyKeyName(node);
            if (key === DECLARED_BUILD) {
              context.report({ node, messageId: "declaredBuildRead" });
            }
            // `const { createOnlineIndexGate } = gate` or `= await import(...)`.
            if (key !== null && GATE_OPENERS.has(key)) {
              context.report({ node, messageId: "gateOpener" });
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
          ExportSpecifier(node) {
            const local =
              node.local.type === "Identifier"
                ? node.local.name
                : node.local.value;
            if (GATE_OPENERS.has(local)) {
              context.report({ node, messageId: "gateOpener" });
            }
          },
        };
      },
    },
  },
});
