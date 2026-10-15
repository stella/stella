// Static SQL shapes that can scan an input larger than the returned page.
//
// Flagged: a leading LIKE wildcard, any LIKE on an S3-key column, a
// function or cast in GROUP BY over a corpus relation, OR with a subquery
// operand, and an optional keyset bound (`$1 IS NULL OR id > $1`), which no
// generic plan can use as an index condition; per-source full corpus counts
// also fail even when the aggregate has a LIMIT. Prefix LIKE on other columns,
// SELECT-only expressions, schema constraints, and plain strings pass; the
// optional bound is also read from plain strings, where `$n` is a parameter.
// Analysis follows same-file const bindings; imported or runtime-built SQL is
// opaque. This detector is shared by oxlint and the baseline counter.

import { panic } from "better-result";
import ts from "typescript";

import { HIGH_VOLUME_TABLES } from "../apps/api/src/db/high-volume-tables.ts";

export type SqlPerfHit = {
  kind:
    | "leading-wildcard"
    | "s3-key-like"
    | "group-by-expression"
    | "or-subquery"
    | "optional-keyset"
    | "per-source-full-count";
  line: number;
  column: number;
  /**
   * Lines where a TypeScript comment can sit for this hit: its own line, the
   * start of the SQL template or call holding it, and the start of the
   * statement around that. A hit inside a multi-line template has no
   * TypeScript line of its own.
   */
  anchorLines: number[];
};

export type SqlPerfCommentError = { line: number; message: string };

/**
 * Kinds the per-file baseline holds. The later kinds start at zero: every hit
 * is reported whatever the file's baseline count.
 */
export const isBaselinedSqlPerfKind = (kind: SqlPerfHit["kind"]): boolean =>
  kind !== "or-subquery" &&
  kind !== "optional-keyset" &&
  kind !== "per-source-full-count";

const LIKE = /\b(?:NOT\s+)?I?LIKE\b/giu;
const CORPUS =
  /\b(?:case_law_decisions|legislation_documents|case_law_[a-z_]*citation[a-z_]*|caseLawDecisions|legislationDocuments|caseLaw\w*Citation\w*)\b/iu;
const GROUP_EXPRESSION =
  /\b(?:to_char|date_trunc|extract|substring|split_part|coalesce|lower|cast)\s*\(|::\s*text\b|->>/iu;
const GROUP_NON_COLUMNS =
  /\b(?:to_char|date_trunc|extract|substring|split_part|coalesce|lower|cast|text|year|month|day|from|for|as|null|true|false|now|current_date|current_timestamp)\b/giu;
const SQL_STRING = /'(?:''|[^'])*'/gu;
const SQL_PREDICATE_TOKEN = /__SQL_EXPR_\d+__|[a-z_][\w."]*|[(),=]/giu;
const S3_KEY = /(?:\b[a-z][\w]*_s3_key\b|\b[a-z][\w]*S3Key\b)/iu;
const REASON =
  /^(?:small table\s+[a-z][\w.]*\b|index\s+[a-z][\w.]*\b|bounded by\s+\S[\s\S]*)/iu;
// The reason is trimmed where it is read.
const COMMENT = /\/\/\s*sql-perf-allow:(.*)$/iu;
const COMMENT_START = /\/\/\s*sql-perf-allow\b/iu;
// `<param> IS NULL OR <col> > <param>` and the reverse order, for any range
// operator; the parameter is `$n` or a template placeholder, with a cast.
// Bounded repeats keep a long token from making the scan backtrack.
const KEYSET_PARAMETER = String.raw`(\$\d{1,4}|__SQL_EXPR_\d{1,4}__)`;
// In a migration's routine body the cursor is also a PL/pgSQL variable or a
// record field (`job."cursor_id"`).
const MIGRATION_KEYSET_PARAMETER = String.raw`(?<![\w."$])(\$\d{1,4}|[a-z_]\w{0,62}(?:\."?[a-z_]\w{0,62}"?)?)`;
const KEYSET_CAST = String.raw`(?:\s{0,64}::\s{0,64}[a-z_]\w{0,63}(?:\.[a-z_]\w{0,63})?(?:\[\])?)?`;
const KEYSET_COLUMN = String.raw`(?:__SQL_EXPR_\d{1,4}__|[a-z_"][\w."]{0,255})`;
const KEYSET_RANGE = String.raw`\s{0,64}(?:<=|>=|<|>)\s{0,64}`;
const KEYSET_NULL = String.raw`\s{1,64}IS\s{1,64}NULL`;
const optionalKeysetPatterns = (parameter: string): RegExp[] => [
  new RegExp(
    String.raw`${parameter}${KEYSET_CAST}${KEYSET_NULL}(?:\s{0,64}\)){0,4}\s{1,64}OR\s{1,64}(?:\(\s{0,64}){0,4}${KEYSET_COLUMN}${KEYSET_RANGE}${parameter}${KEYSET_CAST}`,
    "giu",
  ),
  new RegExp(
    String.raw`${KEYSET_COLUMN}${KEYSET_RANGE}${parameter}${KEYSET_CAST}(?:\s{0,64}\)){0,4}\s{1,64}OR\s{1,64}(?:\(\s{0,64}){0,4}${parameter}${KEYSET_CAST}${KEYSET_NULL}`,
    "giu",
  ),
];
const OPTIONAL_KEYSETS = optionalKeysetPatterns(KEYSET_PARAMETER);
const MIGRATION_OPTIONAL_KEYSETS = optionalKeysetPatterns(
  MIGRATION_KEYSET_PARAMETER,
);
const MIGRATION_COMMENT = /--\s*sql-perf-allow:(.*)$/iu;
const MIGRATION_COMMENT_START = /--\s*sql-perf-allow\b/iu;

type TemplateParts = {
  sql: string;
  offsets: number[];
  expressions: ts.Expression[];
};

const location = (file: ts.SourceFile, offset: number) => {
  const { line, character } = file.getLineAndCharacterOfPosition(offset);
  return { line: line + 1, column: character + 1 };
};

const propertyName = (node: ts.Node): string | undefined =>
  ts.isIdentifier(node) ? node.text : undefined;

const isSqlTag = (node: ts.TaggedTemplateExpression): boolean =>
  propertyName(node.tag) === "sql" ||
  (ts.isCallExpression(node.tag) &&
    propertyName(node.tag.expression) === "sql");

const isLikeCall = (node: ts.CallExpression): boolean => {
  const callee = node.expression;
  let name: string | undefined;
  if (ts.isIdentifier(callee)) {
    name = callee.text;
  } else if (ts.isPropertyAccessExpression(callee)) {
    name = callee.name.text;
  }
  return name !== undefined && /^(?:like|ilike|notLike|notIlike)$/u.test(name);
};

const isGroupByCall = (
  node: ts.CallExpression,
): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } =>
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "groupBy";

type DrizzleImports = {
  names: Map<string, string>;
  namespaces: Set<string>;
};

const drizzleImports = (file: ts.SourceFile): DrizzleImports => {
  const names = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "drizzle-orm"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      bindings === undefined
    ) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const specifier of bindings.elements) {
      if (!specifier.isTypeOnly) {
        names.set(
          specifier.name.text,
          specifier.propertyName?.text ?? specifier.name.text,
        );
      }
    }
  }
  return { names, namespaces };
};

const drizzleCallName = (
  call: ts.CallExpression,
  imports: DrizzleImports,
): string | undefined => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return imports.names.get(callee.text);
  }
  return ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    imports.namespaces.has(callee.expression.text)
    ? callee.name.text
    : undefined;
};

const sqlWithoutLiterals = (text: string): string =>
  text
    .replace(SQL_STRING, (literal) => " ".repeat(literal.length))
    .replace(/--[^\n]*/gu, (comment) => " ".repeat(comment.length))
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => " ".repeat(comment.length));

/**
 * Migration text with comments and string literals blanked in one pass, in
 * the order they appear, so an apostrophe in a comment opens no string.
 * Dollar-quoted routine bodies stay: they hold the statements to read.
 */
const migrationSqlWithoutLiterals = (text: string): string =>
  text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/gu, (hidden) =>
    hidden.replace(/[^\n]/gu, " "),
  );

const textOfTemplate = (node: ts.TemplateLiteral): string =>
  ts.isNoSubstitutionTemplateLiteral(node) ? node.text : node.head.text;

const templateStartsWithWildcard = (node: ts.TemplateLiteral): boolean =>
  /^[%_]/u.test(textOfTemplate(node));

const sqlParts = (
  file: ts.SourceFile,
  template: ts.TemplateLiteral,
): TemplateParts => {
  const offsets: number[] = [];
  const expressions: ts.Expression[] = [];
  let sql = "";
  const append = (text: string, start: number) => {
    for (let index = 0; index < text.length; index += 1) {
      offsets.push(start + index);
    }
    sql += text;
  };
  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    append(template.text, template.getStart(file) + 1);
    return { sql, offsets, expressions };
  }
  append(template.head.text, template.head.getStart(file) + 1);
  for (const [index, span] of template.templateSpans.entries()) {
    expressions.push(span.expression);
    const marker = `__SQL_EXPR_${index}__`;
    append(marker, span.expression.getStart(file));
    append(span.literal.text, span.literal.getStart(file) + 1);
  }
  return { sql, offsets, expressions };
};

const holdsStatements = (node: ts.Node): boolean =>
  ts.isBlock(node) ||
  ts.isSourceFile(node) ||
  ts.isModuleBlock(node) ||
  ts.isCaseClause(node) ||
  ts.isDefaultClause(node) ||
  ts.isClassLike(node) ||
  ts.isObjectLiteralExpression(node);

type ConstBinding = { scope: ts.Node; initializer: ts.Expression };
type ConstBindings = Map<string, ConstBinding[]>;

const constBindings = (file: ts.SourceFile): ConstBindings => {
  const bindings: ConstBindings = new Map();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      // oxlint-disable-next-line no-bitwise -- TypeScript encodes declaration kind in flags
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      let scope: ts.Node = node.parent;
      while (!holdsStatements(scope)) {
        scope = scope.parent;
      }
      const binding = { scope, initializer: node.initializer };
      bindings.set(node.name.text, [
        ...(bindings.get(node.name.text) ?? []),
        binding,
      ]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bindings;
};

/**
 * The `const` a name refers to where it is used: the declaration in the
 * innermost scope that contains the use, as the language resolves it.
 */
const bindingAt = (
  identifier: ts.Identifier,
  bindings: ConstBindings,
): ts.Expression | undefined => {
  let innermost: ConstBinding | undefined;
  for (const binding of bindings.get(identifier.text) ?? []) {
    const { scope } = binding;
    const contains = scope.pos <= identifier.pos && identifier.end <= scope.end;
    if (
      contains &&
      (innermost === undefined ||
        scope.end - scope.pos < innermost.scope.end - innermost.scope.pos)
    ) {
      innermost = binding;
    }
  }
  return innermost?.initializer;
};

const resolve = (
  expression: ts.Expression,
  bindings: ConstBindings,
  depth = 0,
): ts.Expression => {
  if (depth > 4 || !ts.isIdentifier(expression)) {
    return expression;
  }
  const initializer = bindingAt(expression, bindings);
  return initializer === undefined
    ? expression
    : resolve(initializer, bindings, depth + 1);
};

const hasSelectBuilder = (
  expression: ts.Expression,
  bindings: ConstBindings,
  file: ts.SourceFile,
  depth = 0,
): boolean => {
  if (depth > 12) {
    return false;
  }
  const value = resolve(expression, bindings);
  if (
    ts.isTaggedTemplateExpression(value) &&
    isSqlTag(value) &&
    /\bSELECT\b/iu.test(sqlWithoutLiterals(sqlParts(file, value.template).sql))
  ) {
    return true;
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    /^select(?:Distinct|DistinctOn)?$/u.test(value.expression.name.text)
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(value, (child) => {
    if (
      ts.isExpression(child) &&
      hasSelectBuilder(child, bindings, file, depth + 1)
    ) {
      found = true;
    }
  });
  return found;
};

type SqlPredicateToken = { value: string; start: number; depth: number };

const SQL_PREDICATE_BOUNDARIES = new Set([
  "AND",
  "OR",
  "WHERE",
  "ON",
  "HAVING",
  "ORDER",
  "GROUP",
  "LIMIT",
  "UNION",
  "JOIN",
  "FROM",
]);

const sqlOrSubqueryOffsets = (
  visible: string,
  expressions: ts.Expression[],
  bindings: ConstBindings,
  file: ts.SourceFile,
): number[] => {
  const tokens: SqlPredicateToken[] = [];
  let depth = 0;
  for (const match of visible.matchAll(SQL_PREDICATE_TOKEN)) {
    const value = match[0].toUpperCase();
    if (value === ")") {
      depth = Math.max(0, depth - 1);
    }
    tokens.push({ value, start: match.index, depth });
    if (value === "(") {
      depth += 1;
    }
  }

  const hasSubquery = (start: number, end: number): boolean => {
    for (let index = start; index < end; index += 1) {
      const token = tokens[index];
      const next = tokens[index + 1];
      if (token?.value === "EXISTS" && next?.value === "(") {
        return true;
      }
      if (
        (token?.value !== "IN" && token?.value !== "ANY") ||
        next?.value !== "(" ||
        (token.value === "ANY" && tokens[index - 1]?.value !== "=")
      ) {
        continue;
      }
      let first = index + 2;
      while (tokens[first]?.value === "(") {
        first += 1;
      }
      const operand = tokens[first]?.value;
      if (operand === "SELECT") {
        return true;
      }
      if (operand?.startsWith("__SQL_EXPR_") && operand.endsWith("__")) {
        const expression = expressions[Number(operand.slice(11, -2))];
        if (
          expression !== undefined &&
          hasSelectBuilder(expression, bindings, file)
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const offsets: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.value !== "OR") {
      continue;
    }
    let start = index;
    while (start > 0) {
      const previous = tokens[start - 1];
      if (
        previous === undefined ||
        previous.depth < token.depth ||
        (previous.depth === token.depth &&
          SQL_PREDICATE_BOUNDARIES.has(previous.value))
      ) {
        break;
      }
      start -= 1;
    }
    let end = index + 1;
    while (end < tokens.length) {
      const following = tokens[end];
      if (
        following === undefined ||
        following.depth < token.depth ||
        (following.depth === token.depth &&
          SQL_PREDICATE_BOUNDARIES.has(following.value))
      ) {
        break;
      }
      end += 1;
    }
    if (hasSubquery(start, index) || hasSubquery(index + 1, end)) {
      offsets.push(token.start);
    }
  }
  return offsets;
};

type SubqueryOperandContext = {
  imports: DrizzleImports;
  bindings: ConstBindings;
  file: ts.SourceFile;
};

const hasSubqueryOperand = (
  expression: ts.Expression,
  context: SubqueryOperandContext,
  depth = 0,
): boolean => {
  if (depth > 12) {
    return false;
  }
  const { imports, bindings, file } = context;
  const value = resolve(expression, bindings);
  if (ts.isTaggedTemplateExpression(value) && isSqlTag(value)) {
    const visible = sqlWithoutLiterals(sqlParts(file, value.template).sql);
    if (
      /\bEXISTS\s*\(/iu.test(visible) ||
      hasSelectBuilder(value, bindings, file)
    ) {
      return true;
    }
  }
  if (ts.isCallExpression(value)) {
    const name = drizzleCallName(value, imports);
    if (name === "exists" || name === "notExists") {
      return true;
    }
    if (
      (name === "inArray" || name === "notInArray") &&
      value.arguments[1] !== undefined &&
      hasSelectBuilder(value.arguments[1], bindings, file)
    ) {
      return true;
    }
  }
  let found = false;
  ts.forEachChild(value, (child) => {
    if (
      ts.isExpression(child) &&
      hasSubqueryOperand(child, context, depth + 1)
    ) {
      found = true;
    }
  });
  return found;
};

const COMPARISONS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "inArray",
  "isNull",
  "isNotNull",
]);
const CURSOR_COMPARISONS = new Set(["gt", "gte", "lt", "lte"]);
const REPORT_CORPUS_TABLES = new Set([
  ...HIGH_VOLUME_TABLES,
  "legislation_documents",
  "legislation_search_documents",
]);

const sqlTableName = (name: string): string =>
  name.replaceAll(/([a-z\d])([A-Z])/gu, "$1_$2").toLowerCase();

const isCorpusColumn = (column: string, bindings: ConstBindings): boolean => {
  const owner = column.slice(0, column.lastIndexOf("."));
  if (REPORT_CORPUS_TABLES.has(sqlTableName(owner))) {
    return true;
  }
  const alias = bindings.get(owner)?.at(0)?.initializer;
  return (
    alias !== undefined &&
    ts.isCallExpression(alias) &&
    ts.isIdentifier(alias.expression) &&
    alias.expression.text === "alias" &&
    alias.arguments[0] !== undefined &&
    REPORT_CORPUS_TABLES.has(sqlTableName(alias.arguments[0].getText()))
  );
};

const FULL_COUNT = /\bcount\s*\([^)]*\)|\bsum\s*\(\s*\+?1(?:\.0+)?\s*\)/iu;
const SOURCE_COLUMN = /\bsource_id\b|\bsourceId\b/iu;
const SOURCE_RELATION =
  /\b(?:case_law_sources|legislation_sources|caseLawSources|legislationSources)\b/u;

const CORPUS_COUNT_TABLE = new RegExp(
  `\\b(?:${[...REPORT_CORPUS_TABLES].join("|")})\\b`,
  "iu",
);

type SqlSourceClause = { kind: "where" | "group" | "on" | null; text: string };
const SOURCE_EQUALITY_VALUE = String.raw`(?<![\w.$])(?:\$\d+|__SQL_EXPR_\d+__|[+-]?\d+(?:\.\d+)?)(?![\w.])`;

/** Keep outer predicates when a nested SELECT introduces its own FROM. */
const sourceClauses = (statement: string): SqlSourceClause[] => {
  const clauses: SqlSourceClause[] = [];
  const scopes: (SqlSourceClause & { subquery: boolean })[] = [
    { kind: null, text: "", subquery: false },
  ];
  const tokens =
    /\b(?:SELECT|WHERE|GROUP\s+BY|FROM|JOIN|ON|HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION|RETURNING)\b|[()]/giu;
  let cursor = 0;
  const flush = (scope: SqlSourceClause) => {
    if (scope.kind !== null) {
      clauses.push({ kind: scope.kind, text: scope.text });
    }
    scope.text = "";
  };
  for (const token of statement.matchAll(tokens)) {
    const scope =
      scopes.at(-1) ?? panic("SQL predicate scanner lost its scope");
    scope.text += statement.slice(cursor, token.index);
    cursor = token.index + token[0].length;
    if (token[0] === "(") {
      scopes.push({ kind: scope.kind, text: "", subquery: false });
      continue;
    }
    if (token[0] === ")") {
      const text = scope.text;
      flush(scope);
      if (scopes.length > 1) {
        scopes.pop();
        const parent =
          scopes.at(-1) ?? panic("SQL predicate scanner lost its parent scope");
        if (!scope.subquery) {
          parent.text += `(${text})`;
        }
      }
      continue;
    }
    flush(scope);
    const kind = token[0].toLowerCase();
    if (kind === "select") {
      scope.subquery = true;
    }
    if (kind === "where") {
      scope.kind = "where";
    } else if (kind.startsWith("group")) {
      scope.kind = "group";
    } else if (kind === "on") {
      scope.kind = "on";
    } else {
      scope.kind = null;
    }
  }
  const scope =
    scopes.at(-1) ?? panic("SQL predicate scanner lost its final scope");
  scope.text += statement.slice(cursor);
  for (const remaining of scopes) {
    flush(remaining);
  }
  return clauses;
};

const sourceFilteredSql = (statement: string): boolean => {
  const sourceAliases = new Set(["case_law_sources", "legislation_sources"]);
  for (const match of statement.matchAll(
    /\b(?:FROM|JOIN)\s+(?:[a-z_]\w*\.)?(?:case_law_sources|legislation_sources)\s+(?:AS\s+)?([a-z_]\w*)/giu,
  )) {
    if (match[1] !== undefined) {
      sourceAliases.add(match[1]);
    }
  }
  return sourceClauses(statement).some(({ kind, text }) => {
    if (kind !== "where" && kind !== "on") {
      return false;
    }
    const restrictedSourceJoin = [...sourceAliases].some(
      (alias) =>
        new RegExp(
          `\\b${alias}\\.(?:adapter_key|id)\\s*=\\s*(?:\\(\\s*)*${SOURCE_EQUALITY_VALUE}`,
          "iu",
        ).test(text) ||
        new RegExp(
          `${SOURCE_EQUALITY_VALUE}\\s*=\\s*${alias}\\.(?:adapter_key|id)\\b`,
          "iu",
        ).test(text),
    );
    return (
      restrictedSourceJoin ||
      new RegExp(
        `\\bsource_id\\b\\s*=\\s*(?:\\(\\s*)*${SOURCE_EQUALITY_VALUE}`,
        "iu",
      ).test(text) ||
      new RegExp(
        `${SOURCE_EQUALITY_VALUE}\\s*=\\s*(?:[a-z_]\\w*\\.)?source_id\\b`,
        "iu",
      ).test(text) ||
      new RegExp(
        String.raw`\bsource_id\b\s+IN\s*\(\s*${SOURCE_EQUALITY_VALUE}\s*\)`,
        "iu",
      ).test(text)
    );
  });
};

const fullSourceCount = (text: string): boolean =>
  sqlWithoutLiterals(text.replace(SQL_STRING, "__SQL_EXPR_0__"))
    .split(";")
    .some(
      (statement) =>
        FULL_COUNT.test(statement) &&
        sourceFilteredSql(sqlTableName(statement.replaceAll('"', ""))) &&
        CORPUS_COUNT_TABLE.test(sqlTableName(statement.replaceAll('"', ""))),
    );

const isSourceRestrictionColumn = (
  column: ts.PropertyAccessExpression,
  { bindings, file }: SubqueryOperandContext,
): boolean => {
  const owner = resolve(column.expression, bindings).getText(file);
  if (column.name.text === "sourceId") {
    return (
      isCorpusColumn(column.getText(file), bindings) ||
      isCorpusColumn(`${owner}.sourceId`, bindings)
    );
  }
  return (
    (column.name.text === "adapterKey" || column.name.text === "id") &&
    SOURCE_RELATION.test(owner)
  );
};

const singletonSourceValue = (
  value: ts.Expression | undefined,
  bindings: ConstBindings,
): ts.Expression | undefined => {
  if (
    value === undefined ||
    !ts.isArrayLiteralExpression(value) ||
    value.elements.length !== 1
  ) {
    return undefined;
  }
  const element = value.elements.at(0);
  if (element === undefined || ts.isSpreadElement(element)) {
    return undefined;
  }
  const resolved = resolve(element, bindings);
  if (
    ts.isPropertyAccessExpression(resolved) &&
    resolved.name.text === "sourceId"
  ) {
    return undefined;
  }
  return resolved;
};

const drizzleSourceCount = (
  node: ts.CallExpression,
  context: SubqueryOperandContext,
): boolean => {
  const { imports, bindings, file } = context;
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    ![
      "where",
      "groupBy",
      "innerJoin",
      "leftJoin",
      "rightJoin",
      "fullJoin",
      "$count",
    ].includes(node.expression.name.text)
  ) {
    return false;
  }
  const dollarCount = node.expression.name.text === "$count";
  const countTable = dollarCount ? node.arguments.at(0) : undefined;
  const state = {
    corpus:
      countTable !== undefined &&
      (isCorpusColumn(`${countTable.getText(file)}.sourceId`, bindings) ||
        isCorpusColumn(
          `${resolve(countTable, bindings).getText(file)}.sourceId`,
          bindings,
        )),
    count: dollarCount,
    source: false,
  };
  // Resolving bindings turns the syntax tree into a graph (recursive closures
  // and aliases can revisit their own initializer).
  const inspected = new Set<ts.Node>();
  const inspectedSources = new Set<ts.Node>();
  const inspect = (child: ts.Node) => {
    if (inspected.has(child)) {
      return;
    }
    inspected.add(child);
    if (ts.isExpression(child)) {
      const value = resolve(child, bindings);
      if (value !== child) {
        if (inspected.has(value)) {
          return;
        }
        inspected.add(value);
      }
      if (ts.isCallExpression(value)) {
        const name = drizzleCallName(value, imports);
        if (name === "count") {
          state.count = true;
        }
        const argument = value.arguments.at(0);
        const operand =
          argument === undefined ? undefined : resolve(argument, bindings);
        if (name === "sum" && operand !== undefined) {
          state.count ||=
            (ts.isNumericLiteral(operand) && operand.text === "1") ||
            (ts.isTaggedTemplateExpression(operand) &&
              isSqlTag(operand) &&
              /^\+?1(?:\.0+)?$/u.test(
                sqlParts(file, operand.template).sql.trim(),
              ));
        }
        if (
          ts.isPropertyAccessExpression(value.expression) &&
          value.expression.name.text === "from"
        ) {
          const table = value.arguments.at(0);
          if (table !== undefined) {
            state.corpus ||=
              isCorpusColumn(`${table.getText(file)}.sourceId`, bindings) ||
              isCorpusColumn(
                `${resolve(table, bindings).getText(file)}.sourceId`,
                bindings,
              );
          }
        }
      }
      if (ts.isTaggedTemplateExpression(value) && isSqlTag(value)) {
        state.count ||= FULL_COUNT.test(
          sqlWithoutLiterals(
            expandedSql({ ...sqlParts(file, value.template), bindings, file }),
          ),
        );
      }
      if (value !== child) {
        ts.forEachChild(value, inspect);
        return;
      }
    }
    ts.forEachChild(child, inspect);
  };
  const inspectSource = (child: ts.Node) => {
    if (inspectedSources.has(child)) {
      return;
    }
    inspectedSources.add(child);
    if (ts.isExpression(child)) {
      const value = resolve(child, bindings);
      if (value !== child) {
        if (inspectedSources.has(value)) {
          return;
        }
        inspectedSources.add(value);
      }
      if (
        ts.isTaggedTemplateExpression(value) &&
        (isSqlTag(value) ||
          (ts.isIdentifier(value.tag) &&
            imports.names.get(value.tag.text) === "sql"))
      ) {
        const predicate = sqlWithoutLiterals(
          expandedSql({
            ...sqlParts(file, value.template),
            bindings,
            file,
          }).replace(SQL_STRING, "__SQL_EXPR_0__"),
        );
        state.source ||= sourceFilteredSql(
          `WHERE ${sqlTableName(predicate.replaceAll('"', ""))}`,
        );
      }
      if (
        ts.isCallExpression(value) &&
        ["eq", "inArray"].includes(drizzleCallName(value, imports) ?? "")
      ) {
        const singletonMembership =
          drizzleCallName(value, imports) === "inArray";
        for (const [index, argument] of value.arguments.entries()) {
          if (singletonMembership && index !== 0) {
            continue;
          }
          const column = resolve(argument, bindings);
          const other = value.arguments.at(index === 0 ? 1 : 0);
          let otherValue =
            other === undefined ? undefined : resolve(other, bindings);
          if (singletonMembership) {
            otherValue = singletonSourceValue(otherValue, bindings);
          }
          if (
            ts.isPropertyAccessExpression(column) &&
            (column.name.text === "sourceId" ||
              column.name.text === "adapterKey" ||
              column.name.text === "id") &&
            otherValue !== undefined &&
            (!ts.isPropertyAccessExpression(otherValue) ||
              (!isSourceRestrictionColumn(otherValue, context) &&
                !isCorpusColumn(otherValue.getText(file), bindings)))
          ) {
            state.source ||= isSourceRestrictionColumn(column, context);
          }
        }
      }
      if (value !== child) {
        ts.forEachChild(value, inspectSource);
        return;
      }
    }
    ts.forEachChild(child, inspectSource);
  };
  for (const argument of node.arguments) {
    inspectSource(argument);
  }
  inspect(node);
  return state.corpus && state.count && state.source;
};

const comparisonColumn = (
  expression: ts.Expression,
  imports: DrizzleImports,
  bindings: ConstBindings,
  file: ts.SourceFile,
): string | undefined => {
  const value = resolve(expression, bindings);
  if (
    !ts.isCallExpression(value) ||
    !COMPARISONS.has(drizzleCallName(value, imports) ?? "")
  ) {
    return undefined;
  }
  const column = value.arguments[0];
  return column !== undefined && ts.isPropertyAccessExpression(column)
    ? column.getText(file)
    : undefined;
};

const comparisonColumns = (
  expression: ts.Expression,
  imports: DrizzleImports,
  bindings: ConstBindings,
  file: ts.SourceFile,
): Set<string> => {
  const columns = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isExpression(node)) {
      const column = comparisonColumn(node, imports, bindings, file);
      if (column !== undefined) {
        columns.add(column);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(resolve(expression, bindings));
  return columns;
};

const isKeysetOr = (
  call: ts.CallExpression,
  imports: DrizzleImports,
  bindings: ConstBindings,
  file: ts.SourceFile,
): boolean => {
  const left = call.arguments[0];
  const right = call.arguments[1];
  if (
    call.arguments.length !== 2 ||
    left === undefined ||
    right === undefined ||
    !ts.isCallExpression(left) ||
    !CURSOR_COMPARISONS.has(drizzleCallName(left, imports) ?? "") ||
    !ts.isCallExpression(right) ||
    drizzleCallName(right, imports) !== "and" ||
    right.arguments.length !== 2
  ) {
    return false;
  }
  const leftColumn = comparisonColumn(left, imports, bindings, file);
  const equality = right.arguments.find(
    (argument) =>
      ts.isCallExpression(argument) &&
      drizzleCallName(argument, imports) === "eq",
  );
  const continuation = right.arguments.find(
    (argument) =>
      ts.isCallExpression(argument) &&
      CURSOR_COMPARISONS.has(drizzleCallName(argument, imports) ?? ""),
  );
  if (
    leftColumn === undefined ||
    equality === undefined ||
    continuation === undefined ||
    !ts.isCallExpression(equality) ||
    !ts.isCallExpression(continuation) ||
    left.arguments[1] === undefined ||
    equality.arguments[1] === undefined
  ) {
    return false;
  }
  const rightColumns = comparisonColumns(right, imports, bindings, file);
  const continuationColumn = comparisonColumn(
    continuation,
    imports,
    bindings,
    file,
  );
  return (
    comparisonColumn(equality, imports, bindings, file) === leftColumn &&
    continuationColumn !== undefined &&
    continuationColumn !== leftColumn &&
    rightColumns.has(leftColumn) &&
    left.arguments[1].getText(file) === equality.arguments[1].getText(file)
  );
};

export type SqlPerfReportHit = {
  line: number;
  column: number;
};

/** Discovery only: cross-column ORs need plan sampling before enforcement. */
export const reportSqlPerfOrColumns = (
  source: string,
  filename: string,
): SqlPerfReportHit[] => {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = constBindings(file);
  const imports = drizzleImports(file);
  const hits: SqlPerfReportHit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && drizzleCallName(node, imports) === "or") {
      const columns = new Set(
        node.arguments.flatMap((argument) => [
          ...comparisonColumns(argument, imports, bindings, file),
        ]),
      );
      if (
        columns.size > 1 &&
        !isKeysetOr(node, imports, bindings, file) &&
        [...columns].some((column) => isCorpusColumn(column, bindings))
      ) {
        hits.push(location(file, node.getStart(file)));
      }
    }
    if (ts.isTaggedTemplateExpression(node) && isSqlTag(node)) {
      const { sql, offsets, expressions } = sqlParts(file, node.template);
      const visible = sqlWithoutLiterals(sql);
      const aliases = new Map<string, string>();
      for (const match of visible.matchAll(
        /\b(?:FROM|JOIN)\s+([a-z_][\w.]*|__SQL_EXPR_\d+__)\s+(?:AS\s+)?([a-z_]\w*)/giu,
      )) {
        const table = match[1];
        const name = match[2];
        if (table !== undefined && name !== undefined) {
          aliases.set(name, table);
        }
      }
      const corpusSqlColumn = (column: string): boolean => {
        const expressionIndex = /__SQL_EXPR_(\d+)__/u.exec(column)?.[1];
        if (expressionIndex !== undefined) {
          const expression = expressions[Number(expressionIndex)];
          return (
            expression !== undefined &&
            isCorpusColumn(expression.getText(file), bindings)
          );
        }
        const owner = column.slice(0, column.lastIndexOf("."));
        const table = aliases.get(owner) ?? owner;
        const tableExpressionIndex = /__SQL_EXPR_(\d+)__/u.exec(table)?.[1];
        if (tableExpressionIndex !== undefined) {
          const expression = expressions[Number(tableExpressionIndex)];
          return (
            expression !== undefined &&
            REPORT_CORPUS_TABLES.has(sqlTableName(expression.getText(file)))
          );
        }
        return REPORT_CORPUS_TABLES.has(sqlTableName(table));
      };
      for (const match of visible.matchAll(/\bOR\b/giu)) {
        const left =
          visible
            .slice(0, match.index)
            .split(/\b(?:WHERE|AND|OR)\b/iu)
            .at(-1) ?? "";
        const right =
          visible
            .slice(match.index + match[0].length)
            .split(/\b(?:AND|OR|ORDER|GROUP|LIMIT|HAVING)\b/iu)
            .at(0) ?? "";
        // SQL identifiers are shorter than this bound; it also keeps a long
        // nonmatching token from making the report-only scan backtrack.
        const columnPattern =
          /(__SQL_EXPR_\d+__|[a-z_][\w.]{0,255})\s*(?:=|<>|!=|<=|>=|<|>|(?:NOT\s+)?I?LIKE\b|IN\s*\()/giu;
        const leftColumn = [...left.matchAll(columnPattern)].at(-1)?.[1];
        const rightColumn = [...right.matchAll(columnPattern)].at(0)?.[1];
        if (
          leftColumn !== undefined &&
          rightColumn !== undefined &&
          leftColumn !== rightColumn &&
          (corpusSqlColumn(leftColumn) || corpusSqlColumn(rightColumn))
        ) {
          hits.push(
            location(file, offsets[match.index] ?? node.getStart(file)),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
};

const startsWithWildcard = (
  expression: ts.Expression,
  bindings: ConstBindings,
): boolean => {
  const value = resolve(expression, bindings);
  if (ts.isStringLiteral(value)) {
    return /^[%_]/u.test(value.text);
  }
  if (ts.isTemplateLiteral(value)) {
    return templateStartsWithWildcard(value);
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return startsWithWildcard(value.left, bindings);
  }
  return false;
};

const containsCorpus = (text: string): boolean => CORPUS.test(text);

const sqlExpressionText = (
  expression: ts.Expression,
  bindings: ConstBindings,
  file: ts.SourceFile,
): string => {
  const value = resolve(expression, bindings);
  return ts.isTaggedTemplateExpression(value) && isSqlTag(value)
    ? sqlParts(file, value.template).sql
    : value.getText(file);
};

const groupExpression = (
  expression: ts.Expression,
  bindings: ConstBindings,
  file: ts.SourceFile,
): boolean =>
  isGroupExpressionText(sqlExpressionText(expression, bindings, file));

const isGroupExpressionText = (text: string): boolean =>
  GROUP_EXPRESSION.test(text) &&
  /(?:__SQL_EXPR_\d+__|\b[a-z_][\w]*(?:\.[a-z_][\w]*)?\b)/iu.test(
    text.replace(SQL_STRING, " ").replace(GROUP_NON_COLUMNS, " "),
  );

const groupItems = (text: string) => {
  const items: { text: string; start: number }[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'") {
      if (quoted && text[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      items.push({ text: text.slice(start, index), start });
      start = index + 1;
    }
  }
  items.push({ text: text.slice(start), start });
  return items;
};

const allowCommentsOf = (source: string, file: ts.SourceFile) => {
  const comments: { line: number; reason: string }[] = [];
  const commentStarts = new Set<number>();
  const recordComments = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (
        range.kind !== ts.SyntaxKind.SingleLineCommentTrivia ||
        commentStarts.has(range.pos)
      ) {
        continue;
      }
      commentStarts.add(range.pos);
      const comment = source.slice(range.pos, range.end);
      if (!COMMENT_START.test(comment)) {
        continue;
      }
      const match = COMMENT.exec(comment);
      comments.push({
        line: location(file, range.pos).line,
        reason: match?.[1]?.trim() ?? "",
      });
    }
  };
  const visit = (node: ts.Node) => {
    recordComments(ts.getLeadingCommentRanges(source, node.getFullStart()));
    recordComments(ts.getTrailingCommentRanges(source, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return comments;
};

export const listSqlPerfAllowComments = (source: string, filename: string) => {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return allowCommentsOf(source, file);
};

const OPERAND_CHARACTER = /[\w."-]/u;

/**
 * The operand a LIKE follows: the run of identifier, quote, dot and dash
 * characters ending the text, trailing whitespace ignored. Walked by hand so
 * a long input cannot make a backtracking pattern re-scan it.
 */
const trailingOperand = (text: string): string => {
  const trimmed = text.trimEnd();
  let start = trimmed.length;
  while (start > 0 && OPERAND_CHARACTER.test(trimmed[start - 1] ?? "")) {
    start -= 1;
  }
  return trimmed.slice(start);
};

/** The text after a LIKE, past whitespace and one opening parenthesis. */
const leadingOperand = (text: string): string => {
  const trimmed = text.trimStart();
  return trimmed.startsWith("(") ? trimmed.slice(1).trimStart() : trimmed;
};

/** The statement (or class member) a node sits in, where a comment can go. */
const statementOf = (node: ts.Node): ts.Node => {
  let current = node;
  while (!ts.isSourceFile(current) && !holdsStatements(current.parent)) {
    current = current.parent;
  }
  return current;
};

/**
 * Offsets of optional keyset bounds in a page (a statement with a LIMIT): the
 * parameter tested for NULL is the one the range compares against.
 * Placeholders count as parameters only in a `sql` template (`expressions`);
 * in a plain string only `$n` does.
 */
const optionalKeysetOffsets = (
  text: string,
  expressions: readonly ts.Expression[],
  file: ts.SourceFile,
): number[] => {
  const visible = sqlWithoutLiterals(text);
  if (!/\bLIMIT\b/iu.test(visible)) {
    return [];
  }
  const parameterText = (parameter: string | undefined) =>
    parameter?.startsWith("$") === true
      ? parameter
      : expressions[Number(parameter?.slice(11, -2))]?.getText(file);
  return OPTIONAL_KEYSETS.flatMap((pattern) =>
    [...visible.matchAll(pattern)].flatMap((match) => {
      const tested = parameterText(match[1]);
      return tested !== undefined && tested === parameterText(match[2])
        ? [match.index]
        : [];
    }),
  );
};

export type SqlPerfMigrationHit = { line: number; column: number };

/**
 * A cursor name as PostgreSQL resolves it, per dot-separated part: an
 * unquoted part folds to lower case, a quoted part keeps its case.
 */
const resolvedName = (name: string): string =>
  name
    .split(".")
    .map((part) =>
      part.startsWith('"') ? part.slice(1, -1) : part.toLowerCase(),
    )
    .join(".");

/**
 * Optional keyset bounds in a migration, statement by statement (routine
 * bodies included): in a statement with a LIMIT, a cursor that is `$n`, a
 * PL/pgSQL variable or a record field, tested for NULL and compared in the
 * same predicate. A `-- sql-perf-allow: <reason>` comment on the line of a hit
 * or the line above it allows that hit.
 */
export const analyzeMigrationSqlPerf = (source: string) => {
  const visible = migrationSqlWithoutLiterals(source);
  const place = (offset: number): SqlPerfMigrationHit => {
    const before = source.slice(0, offset);
    return {
      line: before.split("\n").length,
      column: offset - before.lastIndexOf("\n"),
    };
  };
  const rawHits: SqlPerfMigrationHit[] = [];
  let start = 0;
  for (const statement of visible.split(";")) {
    if (/\bLIMIT\b/iu.test(statement)) {
      for (const pattern of MIGRATION_OPTIONAL_KEYSETS) {
        for (const match of statement.matchAll(pattern)) {
          if (
            match[1] !== undefined &&
            match[2] !== undefined &&
            resolvedName(match[1]) === resolvedName(match[2])
          ) {
            rawHits.push(place(start + match.index));
          }
        }
      }
    }
    start += statement.length + 1;
  }
  const comments = source.split("\n").flatMap((text, index) =>
    MIGRATION_COMMENT_START.test(text)
      ? [
          {
            line: index + 1,
            reason: MIGRATION_COMMENT.exec(text)?.[1]?.trim() ?? "",
            used: false,
          },
        ]
      : [],
  );
  const hits = rawHits.filter((hit) => {
    const comment = comments.find(
      (entry) =>
        (entry.line === hit.line || entry.line === hit.line - 1) &&
        REASON.test(entry.reason),
    );
    if (comment === undefined) {
      return true;
    }
    comment.used = true;
    return false;
  });
  const commentErrors: SqlPerfCommentError[] = comments.flatMap((comment) => {
    if (!REASON.test(comment.reason)) {
      return [
        {
          line: comment.line,
          message:
            "sql-perf-allow requires small table <name>, index <name>, or bounded by <description>.",
        },
      ];
    }
    return comment.used
      ? []
      : [
          {
            line: comment.line,
            message: "sql-perf-allow suppresses no SQL performance finding.",
          },
        ];
  });
  return { hits, commentErrors };
};

/** A string or untagged template: SQL text whose `$n` are parameters. */
const plainSqlText = (node: ts.Node, file: ts.SourceFile) => {
  if (ts.isStringLiteral(node)) {
    const start = node.getStart(file) + 1;
    return {
      sql: node.text,
      expressions: [],
      offsetAt: (index: number) => start + index,
    };
  }
  if (
    (ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)) &&
    !ts.isTaggedTemplateExpression(node.parent)
  ) {
    const { sql, offsets, expressions } = sqlParts(file, node);
    return {
      sql,
      expressions,
      offsetAt: (index: number) => offsets[index] ?? node.getStart(file),
    };
  }
  return undefined;
};

type ExpandedSqlOptions = {
  sql: string;
  expressions: ts.Expression[];
  bindings: ConstBindings;
  file: ts.SourceFile;
};

const expandedSql = ({
  sql,
  expressions,
  bindings,
  file,
}: ExpandedSqlOptions) =>
  sql.replace(/__SQL_EXPR_(\d+)__/gu, (marker, index: string) => {
    const expression = expressions.at(Number(index));
    if (expression === undefined) {
      return marker;
    }
    const value = resolve(expression, bindings);
    const text = value.getText(file);
    return ts.isTaggedTemplateExpression(value) ||
      (ts.isPropertyAccessExpression(value) &&
        (SOURCE_COLUMN.test(text) || value.name.text === "adapterKey")) ||
      (ts.isNumericLiteral(value) && value.text === "1") ||
      CORPUS_COUNT_TABLE.test(sqlTableName(text)) ||
      SOURCE_RELATION.test(text)
      ? text
      : marker;
  });

export const analyzeSqlPerf = (source: string, filename: string) => {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = constBindings(file);
  const imports = drizzleImports(file);
  const subqueryOperandContext = { imports, bindings, file };
  const rawHits: SqlPerfHit[] = [];
  const seen = new Set<string>();
  const add = (kind: SqlPerfHit["kind"], offset: number, holder: ts.Node) => {
    const place = location(file, offset);
    const key = `${kind}:${place.line}:${place.column}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    rawHits.push({
      kind,
      ...place,
      anchorLines: [
        place.line,
        location(file, holder.getStart(file)).line,
        location(file, statementOf(holder).getStart(file)).line,
      ],
    });
  };

  const inspectSql = (node: ts.TaggedTemplateExpression) => {
    if (!isSqlTag(node)) {
      return;
    }
    const { sql, offsets, expressions } = sqlParts(file, node.template);
    if (fullSourceCount(expandedSql({ sql, expressions, bindings, file }))) {
      add("per-source-full-count", node.getStart(file), node);
    }
    for (const index of optionalKeysetOffsets(sql, expressions, file)) {
      add("optional-keyset", offsets[index] ?? node.getStart(file), node);
    }
    for (const index of sqlOrSubqueryOffsets(
      sqlWithoutLiterals(sql),
      expressions,
      bindings,
      file,
    )) {
      add("or-subquery", offsets[index] ?? node.getStart(file), node);
    }
    for (const match of /\bCHECK\s*\(/iu.test(sql) ? [] : sql.matchAll(LIKE)) {
      const index = match.index;
      const after = sql.slice(index + match[0].length);
      const before = sql.slice(Math.max(0, index - 100), index);
      const lhs = trailingOperand(before);
      const lhsMarker = /__SQL_EXPR_(\d+)__/u.exec(lhs);
      const lhsExpression =
        lhsMarker === null ? undefined : expressions[Number(lhsMarker[1])];
      const lhsText =
        lhsExpression === undefined ? lhs : lhsExpression.getText(file);
      const offset = offsets[index] ?? node.getStart(file);
      if (S3_KEY.test(lhsText)) {
        add("s3-key-like", offset, node);
      }

      const pattern = leadingOperand(after);
      const literal =
        /^['"]/u.test(pattern) && /^[%_]/u.test(pattern.slice(1).trimStart());
      const operand = /^__SQL_EXPR_(\d+)__/u.exec(pattern);
      const expression =
        operand === null ? undefined : expressions[Number(operand[1])];
      if (
        literal ||
        (expression !== undefined && startsWithWildcard(expression, bindings))
      ) {
        add("leading-wildcard", offset, node);
      }
    }
    const group = /\bGROUP\s+BY\b/giu;
    for (const match of sql.matchAll(group)) {
      if (
        !containsCorpus(sql) &&
        !expressions.some((expression) =>
          containsCorpus(expression.getText(file)),
        )
      ) {
        continue;
      }
      const groupText =
        sql
          .slice(match.index + match[0].length)
          .split(/\b(?:ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION)\b/iu)
          .at(0) ?? "";
      for (const item of groupItems(groupText)) {
        const marker = /__SQL_EXPR_(\d+)__/u.exec(item.text);
        const expression =
          marker === null ? undefined : expressions[Number(marker[1])];
        if (
          isGroupExpressionText(item.text) ||
          (expression !== undefined &&
            groupExpression(expression, bindings, file))
        ) {
          const cursor = match.index + match[0].length + item.start;
          add(
            "group-by-expression",
            offsets[cursor] ?? node.getStart(file),
            node,
          );
        }
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      inspectSql(node);
    }
    const plain = plainSqlText(node, file);
    if (plain !== undefined) {
      const { sql, expressions } = plain;
      if (fullSourceCount(expandedSql({ sql, expressions, bindings, file }))) {
        add("per-source-full-count", node.getStart(file), node);
      }
      for (const index of optionalKeysetOffsets(plain.sql, [], file)) {
        add("optional-keyset", plain.offsetAt(index), node);
      }
    }
    if (ts.isCallExpression(node)) {
      if (drizzleSourceCount(node, subqueryOperandContext)) {
        add("per-source-full-count", node.getStart(file), node);
      }
      if (
        drizzleCallName(node, imports) === "or" &&
        node.arguments.some((argument) =>
          hasSubqueryOperand(argument, subqueryOperandContext),
        )
      ) {
        add("or-subquery", node.getStart(file), node);
      }
      if (isLikeCall(node) && node.arguments.length >= 2) {
        const column = node.arguments[0];
        const pattern = node.arguments[1];
        if (column !== undefined && S3_KEY.test(column.getText(file))) {
          add("s3-key-like", node.getStart(file), node);
        }
        if (pattern !== undefined && startsWithWildcard(pattern, bindings)) {
          add("leading-wildcard", node.getStart(file), node);
        }
      }
      if (isGroupByCall(node)) {
        const receiver = node.expression.expression.getText(file);
        if (containsCorpus(receiver)) {
          for (const argument of node.arguments) {
            if (groupExpression(argument, bindings, file)) {
              add("group-by-expression", argument.getStart(file), node);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const comments = allowCommentsOf(source, file).map(({ line, reason }) => ({
    line,
    reason,
    used: false,
  }));
  const hits = rawHits.filter((hit) => {
    const comment = comments.find(
      (entry) =>
        hit.anchorLines.some(
          (line) => entry.line === line || entry.line === line - 1,
        ) && REASON.test(entry.reason),
    );
    if (comment === undefined) {
      return true;
    }
    comment.used = true;
    return false;
  });
  const commentErrors: SqlPerfCommentError[] = comments.flatMap((comment) => {
    if (!REASON.test(comment.reason)) {
      return [
        {
          line: comment.line,
          message:
            "sql-perf-allow requires small table <name>, index <name>, or bounded by <description>.",
        },
      ];
    }
    return comment.used
      ? []
      : [
          {
            line: comment.line,
            message: "sql-perf-allow suppresses no SQL performance finding.",
          },
        ];
  });
  return { hits, commentErrors };
};
