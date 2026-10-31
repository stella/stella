#!/usr/bin/env bun
// Every `ON CONFLICT` arbiter in the API must exist before the release that
// names it serves traffic. Indexes from SQL migrations do; online work exists
// only once something builds it: every migrate run builds deploy-blocking and
// finalized work, while pending work waits for the post-deploy runner. A
// conflict target that resolves to pending work fails its writes until then,
// so this guard resolves every target in apps/api/src and apps/api/scripts to
// its unique index and refuses pending ones, and any target it cannot resolve.
//
// Usage: bun scripts/check-conflict-target-lifecycle.ts

import { panic } from "better-result";
import { getColumns, getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import * as agentAuthSchema from "../apps/api/src/db/agent-auth-schema";
import * as authSchema from "../apps/api/src/db/auth-schema";
import { ONLINE_MIGRATION_INDEXES } from "../apps/api/src/db/online-migrations";
import {
  ONLINE_UNIQUE_INDEX_NAMES,
  ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS,
  onlineIndexColumnTarget,
} from "../apps/api/src/db/online-unique-indexes";
import {
  isMigrateReady,
  ONLINE_WORK_LIFECYCLE,
  type OnlineWorkLifecycle,
} from "../apps/api/src/db/online-work-lifecycle";
import * as schema from "../apps/api/src/db/schema";

const ROOT = path.resolve(import.meta.dir, "..");
const SOURCE_ROOTS = ["apps/api/src", "apps/api/scripts"] as const;

/**
 * The one symbol through which a conflict target built at runtime resolves:
 * the scoped upsert's identity, whose arbiter `defineScopedTransitions` types
 * as an online index every migrate run builds or a schema-declared key. Any
 * other target the guard cannot read is unresolved.
 */
export const CONFLICT_TARGET_OWNER = {
  file: "apps/api/src/lib/db/transitions.ts",
  specifier: /(?:^|\/)lib\/db\/transitions$/u,
  symbol: "scopedTransitionConflictTarget",
} as const;

/** An online unique index: what a conflict target may resolve to. */
type OnlineUniqueIndex = {
  name: string;
  tableName: string;
  columns: readonly string[];
};

export type ConflictTargetContext = {
  /** Every Drizzle table, by its exported binding name. */
  tables: ReadonlyMap<string, PgTable>;
  onlineIndexes: readonly OnlineUniqueIndex[];
  /** Constant names that export an online unique index name. */
  indexNameConstants: Readonly<Record<string, string>>;
  lifecycle: Readonly<Record<string, OnlineWorkLifecycle>>;
};

export type ConflictTargetFinding = {
  file: string;
  line: number;
  reason: string;
};

type Arbiter =
  | { type: "columns"; tableName: string; columns: readonly string[] }
  | { type: "index"; name: string }
  | { type: "unresolved"; reason: string };

const SCHEMA_SPECIFIER =
  /(?:^|\/)(?:schema|auth-schema|agent-auth-schema|registration-budget-schema)(?:\/|$)|\/db\/schema\//u;

const sameColumns = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.toSorted().join(",") === right.toSorted().join(",");

const unquote = (column: string) => column.trim().replaceAll('"', "");

type DeclaredUniqueKey = { name: string; columns: readonly string[] };

/** The unique keys a Drizzle table declares, named as PostgreSQL names them. */
const declaredUniqueKeys = (table: PgTable): DeclaredUniqueKey[] => {
  const config = getTableConfig(table);
  const keys: DeclaredUniqueKey[] = [];
  for (const column of config.columns) {
    if (column.primary) {
      keys.push({ name: `${config.name}_pkey`, columns: [column.name] });
    }
    if (column.isUnique) {
      keys.push({
        name: column.uniqueName ?? `${config.name}_${column.name}_key`,
        columns: [column.name],
      });
    }
  }
  for (const key of [...config.primaryKeys, ...config.uniqueConstraints]) {
    keys.push({
      name: key.getName(),
      columns: key.columns.map(({ name }) => name),
    });
  }
  for (const index of config.indexes) {
    if (!index.config.unique || index.config.name === undefined) {
      continue;
    }
    const columns = index.config.columns.flatMap((column) =>
      "name" in column && typeof column.name === "string" ? [column.name] : [],
    );
    if (columns.length === index.config.columns.length) {
      keys.push({ name: index.config.name, columns });
    }
  }
  return keys;
};

/** Every unique index name a Drizzle table declares, expression ones too. */
const declaredUniqueIndexNames = (table: PgTable): string[] =>
  getTableConfig(table).indexes.flatMap((index) =>
    index.config.unique && index.config.name !== undefined
      ? [index.config.name]
      : [],
  );

const tablesBySqlName = (tables: ReadonlyMap<string, PgTable>) =>
  new Map([...tables.values()].map((table) => [getTableName(table), table]));

/** Where an arbiter lands: a lifecycle verdict, or nothing at all. */
const judge = (
  arbiter: Arbiter,
  context: ConflictTargetContext,
): string | null => {
  const lifecycleProblem = (name: string) => {
    const entry = context.lifecycle[name];
    if (entry === undefined) {
      return `online unique index ${name} has no lifecycle entry`;
    }
    return isMigrateReady(entry)
      ? null
      : `conflict target ${name} is pending online work, which no migrate run builds; register it DEPLOY_BLOCKING or target an index the migrate step builds`;
  };
  // Any matched name with a lifecycle entry is online work, whatever shape
  // its registry or schema declaration takes.
  const verdict = (name: string) =>
    Object.hasOwn(context.lifecycle, name) ||
    context.onlineIndexes.some((index) => index.name === name)
      ? lifecycleProblem(name)
      : null;
  switch (arbiter.type) {
    case "unresolved":
      return `conflict target cannot be resolved to a unique index (${arbiter.reason}); name it inline or through onlineUniqueIndexTarget`;
    case "index": {
      const declared = [...context.tables.values()].some(
        (table) =>
          declaredUniqueKeys(table).some(({ name }) => name === arbiter.name) ||
          declaredUniqueIndexNames(table).includes(arbiter.name),
      );
      if (
        !declared &&
        !context.onlineIndexes.some(({ name }) => name === arbiter.name)
      ) {
        return `conflict target ${arbiter.name} is no declared unique constraint or index`;
      }
      return verdict(arbiter.name);
    }
    case "columns": {
      const online = context.onlineIndexes.find(
        (index) =>
          index.tableName === arbiter.tableName &&
          sameColumns(index.columns, arbiter.columns),
      );
      if (online !== undefined) {
        return verdict(online.name);
      }
      const table = tablesBySqlName(context.tables).get(arbiter.tableName);
      if (table === undefined) {
        return `conflict target cannot be resolved to a unique index (${arbiter.tableName} is no schema table); name it inline or through onlineUniqueIndexTarget`;
      }
      const key = declaredUniqueKeys(table).find(({ columns }) =>
        sameColumns(columns, arbiter.columns),
      );
      return key === undefined
        ? `conflict target ${arbiter.tableName}(${arbiter.columns.join(", ")}) matches no unique key the schema declares`
        : verdict(key.name);
    }
    default:
      arbiter satisfies never;
      return panic("Unknown conflict arbiter");
  }
};

type FileScope = {
  file: string;
  ast: ts.SourceFile;
  /** Local binding -> imported export name, for schema imports. */
  schemaImports: ReadonlyMap<string, string>;
  /** Namespace bindings of schema modules. */
  schemaNamespaces: ReadonlySet<string>;
  /** Local binding -> imported export name, for any named import. */
  namedImports: ReadonlyMap<string, string>;
  /** Const initializers by binding name; a repeated name is ambiguous. */
  constants: ReadonlyMap<string, ts.Expression | null>;
  /**
   * Names some other binding also declares (a parameter, a `let`, a
   * destructured name): which one a use means depends on scope, so none
   * resolves.
   */
  shadowed: ReadonlySet<string>;
  /** Local bindings of `CONFLICT_TARGET_OWNER.symbol`. */
  owners: ReadonlySet<string>;
  context: ConflictTargetContext;
};

const readScope = (
  file: string,
  ast: ts.SourceFile,
  context: ConflictTargetContext,
): FileScope => {
  const schemaImports = new Map<string, string>();
  const schemaNamespaces = new Set<string>();
  const namedImports = new Map<string, string>();
  const owners = new Set<string>();
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    const fromSchema = SCHEMA_SPECIFIER.test(statement.moduleSpecifier.text);
    const fromOwner = CONFLICT_TARGET_OWNER.specifier.test(
      statement.moduleSpecifier.text.replace(/\.ts$/u, ""),
    );
    if (ts.isNamespaceImport(bindings)) {
      if (fromSchema) {
        schemaNamespaces.add(bindings.name.text);
      }
      continue;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      namedImports.set(element.name.text, imported);
      if (fromSchema) {
        schemaImports.set(element.name.text, imported);
      }
      if (fromOwner && imported === CONFLICT_TARGET_OWNER.symbol) {
        owners.add(element.name.text);
      }
    }
  }
  const constants = new Map<string, ts.Expression | null>();
  const shadowed = new Set<string>();
  const bindNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      shadowed.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        bindNames(element.name);
      }
    }
  };
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.getFirstToken(ast)?.kind === ts.SyntaxKind.ConstKeyword
    ) {
      const name = node.name.text;
      constants.set(
        name,
        constants.has(name) ? null : (node.initializer ?? null),
      );
    } else if (ts.isVariableDeclaration(node)) {
      bindNames(node.name);
    } else if (ts.isParameter(node) || ts.isBindingElement(node)) {
      bindNames(node.name);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      shadowed.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(ast);
  if (
    file === CONFLICT_TARGET_OWNER.file &&
    constants.get(CONFLICT_TARGET_OWNER.symbol)
  ) {
    owners.add(CONFLICT_TARGET_OWNER.symbol);
  }
  return {
    file,
    ast,
    schemaImports,
    schemaNamespaces,
    namedImports,
    constants,
    shadowed,
    owners,
    context,
  };
};

const unwrap = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const MAX_DEPTH = 8;

const resolveTable = (
  scope: FileScope,
  expression: ts.Expression,
  depth = 0,
): PgTable | undefined => {
  const node = unwrap(expression);
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  if (ts.isIdentifier(node)) {
    if (scope.shadowed.has(node.text)) {
      return undefined;
    }
    const imported = scope.schemaImports.get(node.text);
    if (imported !== undefined) {
      return scope.context.tables.get(imported);
    }
    const initializer = scope.constants.get(node.text);
    if (initializer === undefined || initializer === null) {
      return undefined;
    }
    // A table declared in this file is one of the exported schema tables.
    if (ts.isCallExpression(unwrap(initializer))) {
      return scope.context.tables.get(node.text);
    }
    return resolveTable(scope, initializer, depth + 1);
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    !scope.shadowed.has(node.expression.text) &&
    scope.schemaNamespaces.has(node.expression.text)
  ) {
    return scope.context.tables.get(node.name.text);
  }
  return undefined;
};

const resolveIndexName = (
  scope: FileScope,
  expression: ts.Expression,
  depth = 0,
): string | undefined => {
  const node = unwrap(expression);
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    !scope.shadowed.has(node.expression.text) &&
    (scope.namedImports.get(node.expression.text) ?? node.expression.text) ===
      "ONLINE_UNIQUE_INDEX_NAMES"
  ) {
    return scope.context.indexNameConstants[node.name.text];
  }
  if (ts.isIdentifier(node)) {
    if (scope.shadowed.has(node.text)) {
      return undefined;
    }
    const exported =
      scope.context.indexNameConstants[
        scope.namedImports.get(node.text) ?? node.text
      ];
    if (exported !== undefined) {
      return exported;
    }
    const initializer = scope.constants.get(node.text);
    return initializer === undefined || initializer === null
      ? undefined
      : resolveIndexName(scope, initializer, depth + 1);
  }
  return undefined;
};

const resolveTarget = (
  scope: FileScope,
  expression: ts.Expression,
  depth = 0,
): Arbiter => {
  const node = unwrap(expression);
  if (depth > MAX_DEPTH) {
    return { type: "unresolved", reason: "too many indirections" };
  }
  if (ts.isIdentifier(node)) {
    const initializer = scope.shadowed.has(node.text)
      ? undefined
      : scope.constants.get(node.text);
    return initializer === undefined || initializer === null
      ? { type: "unresolved", reason: `${node.text} is no local constant` }
      : resolveTarget(scope, initializer, depth + 1);
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    !scope.shadowed.has(node.expression.text) &&
    (scope.namedImports.get(node.expression.text) ?? node.expression.text) ===
      "onlineUniqueIndexTarget"
  ) {
    const [nameArgument] = node.arguments;
    const name =
      nameArgument === undefined
        ? undefined
        : resolveIndexName(scope, nameArgument);
    return name === undefined
      ? { type: "unresolved", reason: "index name is not a known constant" }
      : { type: "index", name };
  }
  const elements = ts.isArrayLiteralExpression(node)
    ? [...node.elements]
    : [node];
  let table: PgTable | undefined;
  const columns: string[] = [];
  for (const element of elements) {
    const column = unwrap(element);
    if (!ts.isPropertyAccessExpression(column)) {
      return {
        type: "unresolved",
        reason: `${column.getText(scope.ast)} is no table column`,
      };
    }
    const owner = resolveTable(scope, column.expression);
    if (owner === undefined || (table !== undefined && owner !== table)) {
      return {
        type: "unresolved",
        reason: `${column.expression.getText(scope.ast)} is no single schema table`,
      };
    }
    table = owner;
    const declared = Object.entries(getColumns(owner)).find(
      ([key]) => key === column.name.text,
    );
    if (declared === undefined) {
      return {
        type: "unresolved",
        reason: `${column.getText(scope.ast)} is no declared column`,
      };
    }
    columns.push(declared[1].name);
  }
  return table === undefined
    ? { type: "unresolved", reason: "empty conflict target" }
    : { type: "columns", tableName: getTableName(table), columns };
};

type ConflictOptionsTarget =
  | { type: "none" }
  | { type: "expression"; expression: ts.Expression }
  | Extract<Arbiter, { type: "unresolved" }>;

/** The `target` of an `onConflictDo*` options argument, if it names one. */
const targetOf = (
  scope: FileScope,
  options: ts.Expression,
  depth = 0,
): ConflictOptionsTarget => {
  const node = unwrap(options);
  if (ts.isIdentifier(node) && depth <= MAX_DEPTH) {
    const initializer = scope.shadowed.has(node.text)
      ? undefined
      : scope.constants.get(node.text);
    return initializer === undefined || initializer === null
      ? { type: "unresolved", reason: `${node.text} is no local constant` }
      : targetOf(scope, initializer, depth + 1);
  }
  if (!ts.isObjectLiteralExpression(node)) {
    return {
      type: "unresolved",
      reason: "conflict options are no object literal",
    };
  }
  let target: ConflictOptionsTarget = { type: "none" };
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      return { type: "unresolved", reason: "conflict options spread a value" };
    }
    if (property.name?.getText(scope.ast) !== "target") {
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      target = { type: "expression", expression: property.initializer };
    } else if (ts.isShorthandPropertyAssignment(property)) {
      target = { type: "expression", expression: property.name };
    } else {
      return { type: "unresolved", reason: "target is no plain property" };
    }
  }
  return target;
};

const TEMPLATE_HOLE = /__CONFLICT_HOLE_(\d+)__/u;

/** Raw SQL text, with `${...}` holes kept addressable. */
const sqlText = (
  node: ts.Node,
): { text: string; holes: ts.Expression[] } | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, holes: [] };
  }
  if (ts.isTemplateExpression(node)) {
    const holes = node.templateSpans.map(({ expression }) => expression);
    return {
      text:
        node.head.text +
        node.templateSpans
          .map(
            (span, index) => `__CONFLICT_HOLE_${index}__${span.literal.text}`,
          )
          .join(""),
      holes,
    };
  }
  return undefined;
};

/** Whether a `${...}` hole is a call of the conflict target owner. */
const isOwnerTarget = (scope: FileScope, hole: ts.Expression | undefined) =>
  hole !== undefined &&
  ts.isCallExpression(hole) &&
  ts.isIdentifier(hole.expression) &&
  !scope.shadowed.has(hole.expression.text) &&
  scope.owners.has(hole.expression.text);

/** The SQL table names a raw `INSERT INTO` reference may write. */
const resolveTableNames = (
  scope: FileScope,
  expression: ts.Expression,
  depth = 0,
): string[] | undefined => {
  const node = unwrap(expression);
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  const table = resolveTable(scope, node);
  if (table !== undefined) {
    return [getTableName(table)];
  }
  if (
    ts.isTaggedTemplateExpression(node) &&
    ts.isNoSubstitutionTemplateLiteral(node.template) &&
    /^\s*[a-z_][a-z0-9_]*\s*$/u.test(node.template.text)
  ) {
    return [node.template.text.trim()];
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveTableNames(scope, node.whenTrue, depth + 1);
    const whenFalse = resolveTableNames(scope, node.whenFalse, depth + 1);
    return whenTrue === undefined || whenFalse === undefined
      ? undefined
      : [...whenTrue, ...whenFalse];
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    !scope.shadowed.has(node.expression.text)
  ) {
    const callee = scope.constants.get(node.expression.text);
    const body =
      callee !== undefined &&
      callee !== null &&
      ts.isArrowFunction(callee) &&
      !ts.isBlock(callee.body)
        ? callee.body
        : undefined;
    return body === undefined
      ? undefined
      : resolveTableNames(scope, body, depth + 1);
  }
  return undefined;
};

const rawArbiters = (
  scope: FileScope,
  text: string,
  holes: readonly ts.Expression[],
): Arbiter[] => {
  const arbiters: Arbiter[] = [];
  for (const match of text.matchAll(
    /ON\s+CONFLICT\s*(?:ON\s+CONSTRAINT\s+"?([A-Za-z_][A-Za-z0-9_]*)"?|\(([^)]*)\))/giu,
  )) {
    const [, constraint, columnList] = match;
    if (constraint !== undefined) {
      arbiters.push({ type: "index", name: constraint });
      continue;
    }
    const before = text.slice(0, match.index);
    const tableReference = [
      ...before.matchAll(/INSERT\s+INTO\s+((?:[\w"]+\.)?"?[\w]+"?)/giu),
    ]
      .at(-1)
      ?.at(1);
    if (tableReference === undefined || columnList === undefined) {
      arbiters.push({ type: "unresolved", reason: "no INSERT INTO table" });
      continue;
    }
    const columnHole = TEMPLATE_HOLE.exec(columnList.trim());
    if (
      columnHole !== null &&
      columnList.trim() === columnHole[0] &&
      isOwnerTarget(scope, holes[Number(columnHole[1])])
    ) {
      continue;
    }
    const hole = TEMPLATE_HOLE.exec(tableReference);
    let tableNames: string[] | undefined;
    if (hole === null) {
      tableNames = [unquote(tableReference.split(".").at(-1) ?? "")];
    } else {
      const expression = holes[Number(hole[1])];
      tableNames =
        expression === undefined
          ? undefined
          : resolveTableNames(scope, expression);
    }
    const columns = columnList.split(",").map(unquote);
    if (
      tableNames === undefined ||
      tableNames.some((name) => name === "") ||
      columns.some(
        (column) =>
          TEMPLATE_HOLE.test(column) ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(column),
      )
    ) {
      arbiters.push({
        type: "unresolved",
        reason: `raw target ${tableReference}(${columnList}) is no table and column list`,
      });
      continue;
    }
    for (const tableName of tableNames) {
      arbiters.push({ type: "columns", tableName, columns });
    }
  }
  return arbiters;
};

const CONFLICT_METHOD = /^onConflictDo(?:Update|Nothing)$/u;

export const checkConflictTargetSource = ({
  file,
  source,
  context,
}: {
  file: string;
  source: string;
  context: ConflictTargetContext;
}): ConflictTargetFinding[] => {
  if (!/onConflictDo|ON\s+CONFLICT/iu.test(source)) {
    return [];
  }
  const ast = ts.createSourceFile(
    path.resolve(ROOT, file),
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const scope = readScope(file, ast, context);
  const findings: ConflictTargetFinding[] = [];
  const report = (node: ts.Node, arbiter: Arbiter) => {
    const reason = judge(arbiter, context);
    if (reason !== null) {
      findings.push({
        file,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        reason,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      CONFLICT_METHOD.test(node.expression.name.text)
    ) {
      const [options] = node.arguments;
      if (options !== undefined) {
        const target = targetOf(scope, options);
        switch (target.type) {
          case "none":
            break;
          case "expression":
            report(node, resolveTarget(scope, target.expression));
            break;
          case "unresolved":
            report(node, target);
            break;
          default:
            target satisfies never;
            panic("Unknown conflict options target");
        }
      }
    }
    const raw = sqlText(node);
    if (raw !== undefined) {
      for (const arbiter of rawArbiters(scope, raw.text, raw.holes)) {
        report(node, arbiter);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
};

const isApplicationSource = (file: string) =>
  /\.tsx?$/u.test(file) && !/\.(?:test|spec|d)\.tsx?$/u.test(file);

const sourceFiles = (directory: string): string[] =>
  readdirSync(path.resolve(ROOT, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return sourceFiles(file);
      }
      return isApplicationSource(file) ? [file] : [];
    },
  );

/** The repository's own tables, online indexes and lifecycle. */
export const repositoryConflictTargetContext = (): ConflictTargetContext => {
  const tables = new Map<string, PgTable>();
  for (const module of [schema, authSchema, agentAuthSchema]) {
    for (const [name, value] of Object.entries(module)) {
      if (is(value, PgTable)) {
        tables.set(name, value);
      }
    }
  }
  const byName = new Map<string, OnlineUniqueIndex>();
  for (const index of [
    ...ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS,
    ...ONLINE_MIGRATION_INDEXES.filter(({ isUnique }) => isUnique),
  ]) {
    byName.set(index.name, {
      name: index.name,
      tableName: index.tableName,
      columns: onlineIndexColumnTarget(index.definitionBody)
        .split(",")
        .map(unquote),
    });
  }
  return {
    tables,
    onlineIndexes: [...byName.values()],
    indexNameConstants: ONLINE_UNIQUE_INDEX_NAMES,
    lifecycle: ONLINE_WORK_LIFECYCLE,
  };
};

/** Every API source the guard reads, scripts included. */
export const conflictTargetSourceFiles = (): string[] =>
  SOURCE_ROOTS.flatMap(sourceFiles);

export const checkRepositoryConflictTargets = (
  context: ConflictTargetContext = repositoryConflictTargetContext(),
): ConflictTargetFinding[] =>
  conflictTargetSourceFiles().flatMap((file) =>
    checkConflictTargetSource({
      file,
      source: readFileSync(path.resolve(ROOT, file), "utf-8"),
      context,
    }),
  );

if (import.meta.main) {
  const findings = checkRepositoryConflictTargets();
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.reason}`);
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      "Every ON CONFLICT target resolves to an index the migrate step builds.",
    );
  }
}
