import {
  type ImportedFromOptions,
  isAstNode,
  isIdentifierReference,
  isImportedFrom,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "../utils.ts";
import type { PublicCorpusBookkeepingTable } from "./public-corpus-bookkeeping.ts";

type Context = ImportedFromOptions["context"];
type Membership = Pick<
  PublicCorpusBookkeepingTable,
  "schemaExport" | "sqlName" | "moduleId"
>;

type MutationArgs = {
  context: Context;
  node: unknown;
  tables: readonly Membership[];
};

const tableFor = ({ context, node, tables }: MutationArgs) => {
  const imported = resolveImport(context, node);
  return imported === null
    ? undefined
    : tables.find(
        (table) =>
          imported.imported === table.schemaExport &&
          (imported.moduleId === table.moduleId ||
            imported.moduleId === "apps/api/src/db/schema"),
      );
};

// Only this deliberately small grammar is eligible. CTEs, joins, calls, SQL
// fragments, quoted values, and unsupported syntax retain the audit requirement.
// Every token is consumed; matching a write prefix cannot hide another write.
export const staticCorpusWriteTargets = (text: string): string[] | null => {
  if (!/^[a-zA-Z0-9_\s.,;=()]+$/u.test(text)) {
    return null;
  }
  const statements = text
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    return null;
  }
  const targets: string[] = [];
  // Qualification prevents search_path or a temporary relation shadowing it.
  const name = "public\\.([a-z_][a-z0-9_]*)";
  const scalar = "(?:[0-9]+|NULL|TRUE|FALSE)";
  const patterns = [
    new RegExp(
      `^INSERT\\s+INTO\\s+${name}\\s*\\([a-z_][a-z0-9_]*(?:\\s*,\\s*[a-z_][a-z0-9_]*)*\\)\\s+VALUES\\s*\\(${scalar}(?:\\s*,\\s*${scalar})*\\)$`,
      "iu",
    ),
    new RegExp(
      `^UPDATE\\s+${name}\\s+SET\\s+[a-z_][a-z0-9_]*\\s*=\\s*${scalar}(?:\\s*,\\s*[a-z_][a-z0-9_]*\\s*=\\s*${scalar})*(?:\\s+WHERE\\s+[a-z_][a-z0-9_]*\\s*=\\s*${scalar})?$`,
      "iu",
    ),
    new RegExp(
      `^DELETE\\s+FROM\\s+${name}(?:\\s+WHERE\\s+[a-z_][a-z0-9_]*\\s*=\\s*${scalar})?$`,
      "iu",
    ),
  ];
  for (const statement of statements) {
    const target = patterns
      .map((pattern) => pattern.exec(statement)?.at(1))
      .find((value) => value !== undefined);
    if (target === undefined) {
      return null;
    }
    // Unquoted PostgreSQL identifiers fold to lowercase.
    targets.push(target.toLowerCase());
  }
  return targets;
};

type StaticSqlArgs = { context: Context; node: unknown; depth?: number };

const staticSql = ({
  context,
  node,
  depth = 0,
}: StaticSqlArgs): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > 4) {
    return null;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    const init = variable === null ? null : stableInitializer(variable);
    return init === null
      ? null
      : staticSql({ context, node: init, depth: depth + 1 });
  }
  if (
    expression.type !== "TaggedTemplateExpression" ||
    !isImportedFrom({
      context,
      node: expression.tag,
      modules: ["drizzle-orm"],
      names: new Set(["sql"]),
    }) ||
    !isAstNode(expression.quasi) ||
    !Array.isArray(expression.quasi.expressions) ||
    expression.quasi.expressions.length !== 0 ||
    !Array.isArray(expression.quasi.quasis) ||
    expression.quasi.quasis.length !== 1
  ) {
    return null;
  }
  const quasi = expression.quasi.quasis.at(0);
  const value = isAstNode(quasi) ? quasi.value : null;
  return typeof value === "object" &&
    value !== null &&
    "cooked" in value &&
    typeof value.cooked === "string"
    ? value.cooked
    : null;
};

export const isPublicCorpusMutation = ({
  context,
  node,
  tables,
}: MutationArgs): boolean => {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression" || !Array.isArray(call.arguments)) {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method === "insert" || method === "update" || method === "delete") {
    return (
      tableFor({ context, node: call.arguments.at(0), tables }) !== undefined
    );
  }
  if (method !== "execute") {
    return false;
  }
  const text = staticSql({ context, node: call.arguments.at(0) });
  const targets = text === null ? null : staticCorpusWriteTargets(text);
  return (
    targets?.every((target) =>
      tables.some((table) => table.sqlName === target),
    ) ?? false
  );
};
