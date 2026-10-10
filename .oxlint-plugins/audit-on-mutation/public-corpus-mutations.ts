import type { PublicCorpusBookkeepingTable } from "../../apps/api/src/lib/db/public-corpus-audit/membership.ts";
import {
  type ImportedFromOptions,
  isAstNode,
  isIdentifierReference,
  isIdentifier,
  isImportedFrom,
  memberPropertyName,
  resolveImportedExpression,
  exactModuleId,
  repoRelativeFilename,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "../utils.ts";

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
  const binding = resolveImportedExpression(context, node);
  const imported =
    binding === null
      ? null
      : {
          imported: binding.imported,
          moduleId: exactModuleId(
            binding.source,
            repoRelativeFilename(context),
          ),
        };
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
  if (!/^[a-zA-Z0-9_ \t\r\n.,;=()]+$/u.test(text)) {
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

const singleUseInitializer = (context: Context, node: unknown) => {
  const expression = unwrapExpression(node);
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  const initializer = variable === null ? null : stableInitializer(variable);
  const definition = variable?.defs.at(0);
  if (
    initializer === null ||
    variable === null ||
    !isAstNode(definition?.node) ||
    !isIdentifier(definition.node.id, expression.name) ||
    variable.references.some(
      (reference) =>
        !reference.init &&
        (reference.identifier.range[0] !== expression.range[0] ||
          reference.identifier.range[1] !== expression.range[1]),
    )
  ) {
    return null;
  }
  return initializer;
};

type StaticSqlArgs = { context: Context; node: unknown };

const staticSql = ({ context, node }: StaticSqlArgs): string | null => {
  let expression = unwrapExpression(node);
  if (isIdentifierReference(expression)) {
    expression = unwrapExpression(singleUseInitializer(context, expression));
  }
  if (
    expression?.type !== "TaggedTemplateExpression" ||
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

type ReadArgs = MutationArgs & { seen?: Set<unknown> };
const containsRead = ({
  context,
  node,
  tables,
  seen = new Set(),
}: ReadArgs): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null || seen.has(expression)) {
    return true;
  }
  seen.add(expression);
  if (
    expression.type === "Literal" ||
    expression.type === "StringLiteral" ||
    expression.type === "NumericLiteral" ||
    expression.type === "BooleanLiteral" ||
    expression.type === "NullLiteral"
  ) {
    return false;
  }
  if (
    expression.type === "ObjectExpression" &&
    Array.isArray(expression.properties)
  ) {
    return expression.properties.some(
      (property) =>
        !isAstNode(property) ||
        property.type !== "Property" ||
        property.computed === true ||
        containsRead({ context, node: property.value, tables, seen }),
    );
  }
  if (
    expression.type === "ArrayExpression" &&
    Array.isArray(expression.elements)
  ) {
    return expression.elements.some((element) =>
      containsRead({ context, node: element, tables, seen }),
    );
  }
  if (expression.type === "MemberExpression") {
    return tableFor({ context, node: expression.object, tables }) === undefined;
  }
  if (isIdentifierReference(expression)) {
    const initializer = singleUseInitializer(context, expression);
    return (
      initializer === null ||
      containsRead({ context, node: initializer, tables, seen })
    );
  }
  // Opaque calls, SQL templates, spreads and other expressions cannot prove
  // that their input contains only public corpus values.
  return true;
};

const hasProvenExecution = (
  node: unknown,
  terminal: string | null,
): boolean => {
  if (!isAstNode(node) || !isAstNode(node.parent)) {
    return false;
  }
  const parent = node.parent;
  if (parent.type === "AwaitExpression") {
    return parent.argument === node;
  }
  return (
    parent.type === "ReturnStatement" &&
    parent.argument === node &&
    terminal === "execute"
  );
};

const hasUnprovenRead = ({ context, node, tables }: MutationArgs): boolean => {
  let current = unwrapExpression(node);
  const start =
    current?.type === "CallExpression"
      ? unwrapExpression(current.callee)
      : null;
  const mutation =
    start?.type === "MemberExpression" ? memberPropertyName(start) : null;
  let complete = mutation === "delete";
  let terminal = mutation;
  while (current !== null) {
    const parent = isAstNode(current.parent) ? current.parent : null;
    if (parent?.type !== "MemberExpression" || parent.object !== current) {
      break;
    }
    const method = memberPropertyName(parent);
    const invocation = isAstNode(parent.parent) ? parent.parent : null;
    if (
      invocation?.type !== "CallExpression" ||
      !Array.isArray(invocation.arguments)
    ) {
      return true;
    }
    if (
      ![
        "set",
        "values",
        "where",
        "returning",
        "from",
        "onConflictDoNothing",
        "onConflictDoUpdate",
        "execute",
      ].includes(method ?? "")
    ) {
      return true;
    }
    if (
      (mutation === "update" && method === "set") ||
      (mutation === "insert" && method === "values")
    ) {
      complete = true;
    }
    terminal = method;
    if (
      method === "from" &&
      tableFor({ context, node: invocation.arguments.at(0), tables }) ===
        undefined
    ) {
      return true;
    }
    // Expressions supplied to a builder may contain a subquery or opaque SQL.
    const argumentsToCheck =
      method === "from" ? invocation.arguments.slice(1) : invocation.arguments;
    if (
      argumentsToCheck.some((argument) =>
        containsRead({ context, node: argument, tables }),
      )
    ) {
      return true;
    }
    current = invocation;
  }
  // All storage, sharing and unknown parent contexts retain the audit requirement.
  return !complete || !hasProvenExecution(current, terminal);
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
      tableFor({ context, node: call.arguments.at(0), tables }) !== undefined &&
      !hasUnprovenRead({ context, node: call, tables }) &&
      !call.arguments
        .slice(1)
        .some((argument) => containsRead({ context, node: argument, tables }))
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
