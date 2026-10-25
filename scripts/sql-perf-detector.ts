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

import { HIGH_VOLUME_TABLES } from "../apps/api/src/db/high-volume-tables.ts";
import { PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT } from "../apps/api/src/lib/public-law-relations.ts";
import {
  type BindingIdentifier as Identifier,
  type CallExpression,
  type Expression as OxcExpression,
  type MemberExpression,
  type Node,
  type ParsedSource,
  parseSource,
  type SpreadElement,
  type TaggedTemplateExpression,
  type TemplateLiteral,
  walk,
} from "../packages/scripts/src/syntax-tree";

type Expression = OxcExpression | SpreadElement;
type SourceFile = ParsedSource & { parents: ReadonlyMap<Node, Node> };
const parseFile = (filename: string, source: string): SourceFile => {
  const parsed = parseSource(filename, source);
  const parents = new Map<Node, Node>();
  walk(parsed.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
  });
  return { ...parsed, parents };
};
const textOf = (node: Node, file: Pick<ParsedSource, "sourceText">): string =>
  file.sourceText.slice(node.start, node.end);
const isMember = (
  node: Node,
): node is MemberExpression & { computed: false; property: Identifier } =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier";
const isExpression = (node: Node): node is Expression =>
  node.type.endsWith("Expression") ||
  node.type === "Identifier" ||
  node.type === "Literal" ||
  node.type === "TemplateLiteral" ||
  node.type === "JSXElement" ||
  node.type === "JSXFragment" ||
  node.type === "Super" ||
  node.type === "MetaProperty" ||
  node.type === "TSTypeAssertion" ||
  node.type === "SpreadElement";
const forEachChild = (node: Node, visit: (node: Node) => void): void => {
  walk(node, (child, ancestors) => {
    if (ancestors.length === 1) {
      visit(child);
      return "skip-children";
    }
    return undefined;
  });
};

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
  /\b(?:case_law_(?:published_|unredacted_)?decisions|legislation_documents|case_law_[a-z_]*citation[a-z_]*|(?:published|unredacted)?CaseLawDecisions|legislationDocuments|caseLaw\w*Citation\w*)\b/iu;
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
  expressions: Expression[];
};

const location = (file: SourceFile, offset: number) => file.locate(offset);
const propertyName = (node: Node): string | undefined =>
  node.type === "Identifier" ? node.name : undefined;
const isSqlTag = (node: TaggedTemplateExpression): boolean =>
  propertyName(node.tag) === "sql" ||
  (node.tag.type === "CallExpression" &&
    propertyName(node.tag.callee) === "sql");
const isLikeCall = (node: CallExpression): boolean => {
  const callee = node.callee;
  let name;
  if (callee.type === "Identifier") {
    name = callee.name;
  } else if (isMember(callee)) {
    name = callee.property.name;
  }
  return name !== undefined && /^(?:like|ilike|notLike|notIlike)$/u.test(name);
};
const isGroupByCall = (
  node: CallExpression,
): node is CallExpression & {
  callee: MemberExpression & { computed: false; property: Identifier };
} => isMember(node.callee) && node.callee.property.name === "groupBy";
type DrizzleImports = { names: Map<string, string>; namespaces: Set<string> };
const drizzleImports = (file: SourceFile): DrizzleImports => {
  const names = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== "drizzle-orm" ||
      statement.importKind === "type"
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        namespaces.add(specifier.local.name);
      } else if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type"
      ) {
        names.set(
          specifier.local.name,
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value,
        );
      }
    }
  }
  return { names, namespaces };
};
const drizzleCallName = (
  call: CallExpression,
  imports: DrizzleImports,
): string | undefined => {
  const callee = call.callee;
  if (callee.type === "Identifier") {
    return imports.names.get(callee.name);
  }
  return isMember(callee) &&
    callee.object.type === "Identifier" &&
    imports.namespaces.has(callee.object.name)
    ? callee.property.name
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

const textOfTemplate = (node: TemplateLiteral): string =>
  node.quasis.at(0)?.value.cooked ?? "";
const templateStartsWithWildcard = (node: TemplateLiteral): boolean =>
  /^[%_]/u.test(textOfTemplate(node));
const sqlParts = (
  _file: SourceFile,
  template: TemplateLiteral,
): TemplateParts => {
  const offsets: number[] = [];
  const expressions: Expression[] = [];
  let sql = "";
  const append = (text: string, start: number) => {
    for (let index = 0; index < text.length; index += 1) {
      offsets.push(start + index);
    }
    sql += text;
  };
  const first = template.quasis.at(0);
  if (first !== undefined) {
    append(first.value.cooked ?? "", first.start + 1);
  }
  for (const [index, expression] of template.expressions.entries()) {
    expressions.push(expression);
    append(`__SQL_EXPR_${index}__`, expression.start);
    const quasi = template.quasis.at(index + 1);
    if (quasi !== undefined) {
      append(quasi.value.cooked ?? "", quasi.start + 1);
    }
  }
  return { sql, offsets, expressions };
};
const holdsStatements = (node: Node): boolean =>
  [
    "BlockStatement",
    "Program",
    "TSModuleBlock",
    "SwitchCase",
    "ClassDeclaration",
    "ClassExpression",
    "ObjectExpression",
  ].includes(node.type);
type ConstBinding = { scope: Node; initializer: Expression };
type ConstBindings = Map<string, ConstBinding[]> & { sourceText: string };
const constBindings = (file: SourceFile): ConstBindings => {
  const bindings: ConstBindings = Object.assign(
    new Map<string, ConstBinding[]>(),
    { sourceText: file.sourceText },
  );
  walk(file.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (
      node.type !== "VariableDeclarator" ||
      node.id.type !== "Identifier" ||
      node.init === null ||
      parent?.type !== "VariableDeclaration" ||
      parent.kind !== "const"
    ) {
      return;
    }
    const scope = ancestors.findLast(holdsStatements);
    if (scope === undefined) {
      panic("Missing constant binding scope");
    }
    const previous = bindings.get(node.id.name) ?? [];
    previous.push({ scope, initializer: node.init });
    bindings.set(node.id.name, previous);
  });
  return bindings;
};

/**
 * The `const` a name refers to where it is used: the declaration in the
 * innermost scope that contains the use, as the language resolves it.
 */
const bindingAt = (
  identifier: Identifier,
  bindings: ConstBindings,
): Expression | undefined => {
  let innermost: ConstBinding | undefined;
  for (const binding of bindings.get(identifier.name) ?? []) {
    const { scope } = binding;
    const contains =
      scope.start <= identifier.start && identifier.end <= scope.end;
    if (
      contains &&
      (innermost === undefined ||
        scope.end - scope.start < innermost.scope.end - innermost.scope.start)
    ) {
      innermost = binding;
    }
  }
  return innermost?.initializer;
};

const resolve = (
  expression: Expression,
  bindings: ConstBindings,
  depth = 0,
): Expression => {
  if (depth > 4 || expression.type !== "Identifier") {
    return expression;
  }
  const initializer = bindingAt(expression, bindings);
  return initializer === undefined
    ? expression
    : resolve(initializer, bindings, depth + 1);
};

const hasSelectBuilder = (
  expression: Expression,
  bindings: ConstBindings,
  file: SourceFile,
  depth = 0,
): boolean => {
  if (depth > 12) {
    return false;
  }
  const value = resolve(expression, bindings);
  if (
    value.type === "TaggedTemplateExpression" &&
    isSqlTag(value) &&
    /\bSELECT\b/iu.test(sqlWithoutLiterals(sqlParts(file, value.quasi).sql))
  ) {
    return true;
  }
  if (
    value.type === "CallExpression" &&
    isMember(value.callee) &&
    /^select(?:Distinct|DistinctOn)?$/u.test(value.callee.property.name)
  ) {
    return true;
  }
  // TypeScript's expression-only recursion stops at template spans.
  if (value.type === "TemplateLiteral") {
    return false;
  }
  let found = false;
  forEachChild(value, (child) => {
    if (
      isExpression(child) &&
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
  expressions: Expression[],
  bindings: ConstBindings,
  file: SourceFile,
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
  file: SourceFile;
};

const hasSubqueryOperand = (
  expression: Expression,
  context: SubqueryOperandContext,
  depth = 0,
): boolean => {
  if (depth > 12) {
    return false;
  }
  const { imports, bindings, file } = context;
  const value = resolve(expression, bindings);
  if (value.type === "TaggedTemplateExpression" && isSqlTag(value)) {
    const visible = sqlWithoutLiterals(sqlParts(file, value.quasi).sql);
    if (
      /\bEXISTS\s*\(/iu.test(visible) ||
      hasSelectBuilder(value, bindings, file)
    ) {
      return true;
    }
  }
  if (value.type === "CallExpression") {
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
  // TypeScript's expression-only recursion stops at template spans.
  if (value.type === "TemplateLiteral") {
    return false;
  }
  let found = false;
  forEachChild(value, (child) => {
    if (isExpression(child) && hasSubqueryOperand(child, context, depth + 1)) {
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
  PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT.publishedCaseLawDecisions,
  PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT.unredactedCaseLawDecisions,
  "legislation_documents",
  "legislation_search_documents",
]);

const schemaRelationNames = new Map<string, string>(
  Object.entries(PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT),
);
const sqlTableName = (name: string): string =>
  schemaRelationNames.get(name) ??
  name.replaceAll(/([a-z\d])([A-Z])/gu, "$1_$2").toLowerCase();

type SelectedColumnOfOptions = {
  expression: Expression;
  name: string;
  bindings: ConstBindings;
  seen?: Set<string>;
};

const selectedColumnOf = ({
  expression,
  name,
  bindings,
  seen = new Set<string>(),
}: SelectedColumnOfOptions): Expression | undefined => {
  let current = expression;
  if (
    current.type === "CallExpression" &&
    current.callee.type === "Identifier" &&
    !seen.has(current.callee.name)
  ) {
    seen.add(current.callee.name);
    const producer = bindings.get(current.callee.name)?.at(0)?.initializer;
    if (producer?.type === "ArrowFunctionExpression") {
      if (producer.body.type !== "BlockStatement") {
        return selectedColumnOf({
          expression: producer.body,
          name,
          bindings,
          seen,
        });
      }
      const statement = producer.body.body.at(0);
      if (
        producer.body.body.length === 1 &&
        statement?.type === "ReturnStatement" &&
        statement.argument !== null
      ) {
        return selectedColumnOf({
          expression: statement.argument,
          name,
          bindings,
          seen,
        });
      }
    }
  }
  while (current.type === "CallExpression" && isMember(current.callee)) {
    if (current.callee.property.name === "select") {
      const projection = current.arguments.at(0);
      if (projection?.type !== "ObjectExpression") {
        return undefined;
      }
      const selected = projection.properties.find(
        (property) =>
          property.type === "Property" &&
          !property.shorthand &&
          !property.method &&
          property.kind === "init" &&
          ((property.key.type === "Identifier" && property.key.name === name) ||
            (property.key.type === "Literal" &&
              typeof property.key.value === "string" &&
              property.key.value === name)),
      );
      return selected?.type === "Property" &&
        !selected.shorthand &&
        !selected.method &&
        selected.kind === "init"
        ? selected.value
        : undefined;
    }
    current = current.callee.object;
  }
  return undefined;
};

type IsCorpusColumnOptions = {
  column: string;
  bindings: ConstBindings;
  seen?: Set<string>;
};

const isCorpusColumn = ({
  column,
  bindings,
  seen = new Set<string>(),
}: IsCorpusColumnOptions): boolean => {
  const owner = column.slice(0, column.lastIndexOf("."));
  if (owner.length === 0) {
    return false;
  }
  if (REPORT_CORPUS_TABLES.has(sqlTableName(owner))) {
    return true;
  }
  if (seen.has(column)) {
    return false;
  }
  seen.add(column);
  const alias = bindings.get(owner)?.at(0)?.initializer;
  if (
    alias?.type === "CallExpression" &&
    alias.callee.type === "Identifier" &&
    alias.callee.name === "alias" &&
    alias.arguments[0] !== undefined &&
    REPORT_CORPUS_TABLES.has(sqlTableName(textOf(alias.arguments[0], bindings)))
  ) {
    return true;
  }
  const declarations = bindings.get(owner);
  return (
    declarations !== undefined &&
    declarations.length > 0 &&
    declarations.every(({ initializer }) => {
      const selected = selectedColumnOf({
        expression: initializer,
        name: column.slice(column.lastIndexOf(".") + 1),
        bindings,
      });
      return (
        selected !== undefined &&
        isMember(selected) &&
        isCorpusColumn({
          column: textOf(selected, bindings),
          bindings,
          seen: new Set(seen),
        })
      );
    })
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
  column: MemberExpression & { computed: false; property: Identifier },
  { bindings, file }: SubqueryOperandContext,
): boolean => {
  const owner = textOf(resolve(column.object, bindings), file);
  if (column.property.name === "sourceId") {
    return (
      isCorpusColumn({ column: textOf(column, file), bindings }) ||
      isCorpusColumn({ column: `${owner}.sourceId`, bindings })
    );
  }
  return (
    (column.property.name === "adapterKey" || column.property.name === "id") &&
    SOURCE_RELATION.test(owner)
  );
};

const singletonSourceValue = (
  value: Expression | undefined,
  bindings: ConstBindings,
): Expression | undefined => {
  if (value?.type !== "ArrayExpression" || value.elements.length !== 1) {
    return undefined;
  }
  const element = value.elements.at(0);
  if (
    element === undefined ||
    element === null ||
    element.type === "SpreadElement"
  ) {
    return undefined;
  }
  const resolved = resolve(element, bindings);
  if (isMember(resolved) && resolved.property.name === "sourceId") {
    return undefined;
  }
  return resolved;
};

const drizzleSourceCount = (
  node: CallExpression,
  context: SubqueryOperandContext,
): boolean => {
  const { imports, bindings, file } = context;
  if (
    !isMember(node.callee) ||
    ![
      "where",
      "groupBy",
      "innerJoin",
      "leftJoin",
      "rightJoin",
      "fullJoin",
      "$count",
    ].includes(node.callee.property.name)
  ) {
    return false;
  }
  const dollarCount = node.callee.property.name === "$count";
  const countTable = dollarCount ? node.arguments.at(0) : undefined;
  const state = {
    corpus:
      countTable !== undefined &&
      (isCorpusColumn({
        column: `${textOf(countTable, file)}.sourceId`,
        bindings,
      }) ||
        isCorpusColumn({
          column: `${textOf(resolve(countTable, bindings), file)}.sourceId`,
          bindings,
        })),
    count: dollarCount,
    source: false,
  };
  // Resolving bindings turns the syntax tree into a graph (recursive closures
  // and aliases can revisit their own initializer).
  const inspected = new Set<Node>();
  const inspectedSources = new Set<Node>();
  const inspect = (child: Node) => {
    if (inspected.has(child)) {
      return;
    }
    inspected.add(child);
    if (isExpression(child)) {
      const value = resolve(child, bindings);
      if (value !== child) {
        if (inspected.has(value)) {
          return;
        }
        inspected.add(value);
      }
      if (value.type === "CallExpression") {
        const name = drizzleCallName(value, imports);
        if (name === "count") {
          state.count = true;
        }
        const argument = value.arguments.at(0);
        const operand =
          argument === undefined ? undefined : resolve(argument, bindings);
        if (name === "sum" && operand !== undefined) {
          state.count ||=
            (operand.type === "Literal" &&
              typeof operand.value === "number" &&
              operand.value === 1) ||
            (operand.type === "TaggedTemplateExpression" &&
              isSqlTag(operand) &&
              /^\+?1(?:\.0+)?$/u.test(
                sqlParts(file, operand.quasi).sql.trim(),
              ));
        }
        if (isMember(value.callee) && value.callee.property.name === "from") {
          const table = value.arguments.at(0);
          if (table !== undefined) {
            state.corpus ||=
              isCorpusColumn({
                column: `${textOf(table, file)}.sourceId`,
                bindings,
              }) ||
              isCorpusColumn({
                column: `${textOf(resolve(table, bindings), file)}.sourceId`,
                bindings,
              });
          }
        }
      }
      if (value.type === "TaggedTemplateExpression" && isSqlTag(value)) {
        state.count ||= FULL_COUNT.test(
          sqlWithoutLiterals(
            expandedSql({ ...sqlParts(file, value.quasi), bindings, file }),
          ),
        );
      }
      if (value !== child) {
        forEachChild(value, inspect);
        return;
      }
    }
    forEachChild(child, inspect);
  };
  const inspectSource = (child: Node) => {
    if (inspectedSources.has(child)) {
      return;
    }
    inspectedSources.add(child);
    if (isExpression(child)) {
      const value = resolve(child, bindings);
      if (value !== child) {
        if (inspectedSources.has(value)) {
          return;
        }
        inspectedSources.add(value);
      }
      if (
        value.type === "TaggedTemplateExpression" &&
        (isSqlTag(value) ||
          (value.tag.type === "Identifier" &&
            imports.names.get(value.tag.name) === "sql"))
      ) {
        const predicate = sqlWithoutLiterals(
          expandedSql({
            ...sqlParts(file, value.quasi),
            bindings,
            file,
          }).replace(SQL_STRING, "__SQL_EXPR_0__"),
        );
        state.source ||= sourceFilteredSql(
          `WHERE ${sqlTableName(predicate.replaceAll('"', ""))}`,
        );
      }
      if (
        value.type === "CallExpression" &&
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
            isMember(column) &&
            (column.property.name === "sourceId" ||
              column.property.name === "adapterKey" ||
              column.property.name === "id") &&
            otherValue !== undefined &&
            (!isMember(otherValue) ||
              (!isSourceRestrictionColumn(otherValue, context) &&
                !isCorpusColumn({
                  column: textOf(otherValue, file),
                  bindings,
                })))
          ) {
            state.source ||= isSourceRestrictionColumn(column, context);
          }
        }
      }
      if (value !== child) {
        forEachChild(value, inspectSource);
        return;
      }
    }
    forEachChild(child, inspectSource);
  };
  for (const argument of node.arguments) {
    inspectSource(argument);
  }
  inspect(node);
  return state.corpus && state.count && state.source;
};

const comparisonColumn = (
  expression: Expression,
  imports: DrizzleImports,
  bindings: ConstBindings,
  file: SourceFile,
): string | undefined => {
  const value = resolve(expression, bindings);
  if (
    value.type !== "CallExpression" ||
    !COMPARISONS.has(drizzleCallName(value, imports) ?? "")
  ) {
    return undefined;
  }
  const column = value.arguments[0];
  return column !== undefined && isMember(column)
    ? textOf(column, file)
    : undefined;
};

const comparisonColumns = (
  expression: Expression,
  imports: DrizzleImports,
  bindings: ConstBindings,
  file: SourceFile,
): Set<string> => {
  const columns = new Set<string>();
  const visit = (node: Node) => {
    if (isExpression(node)) {
      const column = comparisonColumn(node, imports, bindings, file);
      if (column !== undefined) {
        columns.add(column);
      }
    }
    forEachChild(node, visit);
  };
  visit(resolve(expression, bindings));
  return columns;
};

const isKeysetOr = (
  call: CallExpression,
  imports: DrizzleImports,
  bindings: ConstBindings,
  file: SourceFile,
): boolean => {
  const left = call.arguments[0];
  const right = call.arguments[1];
  if (
    call.arguments.length !== 2 ||
    left === undefined ||
    right === undefined ||
    left.type !== "CallExpression" ||
    !CURSOR_COMPARISONS.has(drizzleCallName(left, imports) ?? "") ||
    right.type !== "CallExpression" ||
    drizzleCallName(right, imports) !== "and" ||
    right.arguments.length !== 2
  ) {
    return false;
  }
  const leftColumn = comparisonColumn(left, imports, bindings, file);
  const equality = right.arguments.find(
    (argument) =>
      argument.type === "CallExpression" &&
      drizzleCallName(argument, imports) === "eq",
  );
  const continuation = right.arguments.find(
    (argument) =>
      argument.type === "CallExpression" &&
      CURSOR_COMPARISONS.has(drizzleCallName(argument, imports) ?? ""),
  );
  if (
    leftColumn === undefined ||
    equality === undefined ||
    continuation === undefined ||
    equality.type !== "CallExpression" ||
    continuation.type !== "CallExpression" ||
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
    textOf(left.arguments[1], file) === textOf(equality.arguments[1], file)
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
  const file = parseFile(filename, source);
  const bindings = constBindings(file);
  const imports = drizzleImports(file);
  const hits: SqlPerfReportHit[] = [];
  const visit = (node: Node) => {
    if (
      node.type === "CallExpression" &&
      drizzleCallName(node, imports) === "or"
    ) {
      const columns = new Set(
        node.arguments.flatMap((argument) => [
          ...comparisonColumns(argument, imports, bindings, file),
        ]),
      );
      if (
        columns.size > 1 &&
        !isKeysetOr(node, imports, bindings, file) &&
        [...columns].some((column) => isCorpusColumn({ column, bindings }))
      ) {
        hits.push(location(file, node.start));
      }
    }
    if (node.type === "TaggedTemplateExpression" && isSqlTag(node)) {
      const { sql, offsets, expressions } = sqlParts(file, node.quasi);
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
            isCorpusColumn({ column: textOf(expression, file), bindings })
          );
        }
        const owner = column.slice(0, column.lastIndexOf("."));
        const table = aliases.get(owner) ?? owner;
        const tableExpressionIndex = /__SQL_EXPR_(\d+)__/u.exec(table)?.[1];
        if (tableExpressionIndex !== undefined) {
          const expression = expressions[Number(tableExpressionIndex)];
          return (
            expression !== undefined &&
            REPORT_CORPUS_TABLES.has(sqlTableName(textOf(expression, file)))
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
          hits.push(location(file, offsets[match.index] ?? node.start));
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(file.program);
  return hits;
};

const startsWithWildcard = (
  expression: Expression,
  bindings: ConstBindings,
): boolean => {
  const value = resolve(expression, bindings);
  if (value.type === "Literal" && typeof value.value === "string") {
    return /^[%_]/u.test(value.value);
  }
  if (value.type === "TemplateLiteral") {
    return templateStartsWithWildcard(value);
  }
  if (value.type === "BinaryExpression" && value.operator === "+") {
    return startsWithWildcard(value.left, bindings);
  }
  return false;
};

const containsCorpus = (text: string): boolean => CORPUS.test(text);

const sqlExpressionText = (
  expression: Expression,
  bindings: ConstBindings,
  file: SourceFile,
): string => {
  const value = resolve(expression, bindings);
  return value.type === "TaggedTemplateExpression" && isSqlTag(value)
    ? sqlParts(file, value.quasi).sql
    : textOf(value, file);
};

const groupExpression = (
  expression: Expression,
  bindings: ConstBindings,
  file: SourceFile,
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

const allowCommentsOf = (source: string, file: SourceFile) =>
  file.comments.flatMap((range) => {
    const comment = source.slice(range.start, range.end);
    if (range.type !== "Line" || !COMMENT_START.test(comment)) {
      return [];
    }
    const match = COMMENT.exec(comment);
    return [
      {
        line: location(file, range.start).line,
        reason: match?.[1]?.trim() ?? "",
      },
    ];
  });

export const listSqlPerfAllowComments = (source: string, filename: string) => {
  const file = parseFile(filename, source);
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
const statementOf = (node: Node, file: SourceFile): Node => {
  let current = node;
  for (;;) {
    const parent = file.parents.get(current);
    if (
      current.type === "Program" ||
      parent === undefined ||
      holdsStatements(parent)
    ) {
      return current;
    }
    current = parent;
  }
};

/**
 * Offsets of optional keyset bounds in a page (a statement with a LIMIT): the
 * parameter tested for NULL is the one the range compares against.
 * Placeholders count as parameters only in a `sql` template (`expressions`);
 * in a plain string only `$n` does.
 */
const expressionTextAt = (
  expressions: readonly Expression[],
  index: number,
  file: SourceFile,
): string | undefined => {
  const expression = expressions.at(index);
  return expression === undefined ? undefined : textOf(expression, file);
};
const optionalKeysetOffsets = (
  text: string,
  expressions: readonly Expression[],
  file: SourceFile,
): number[] => {
  const visible = sqlWithoutLiterals(text);
  if (!/\bLIMIT\b/iu.test(visible)) {
    return [];
  }
  const parameterText = (parameter: string | undefined) =>
    parameter?.startsWith("$") === true
      ? parameter
      : expressionTextAt(expressions, Number(parameter?.slice(11, -2)), file);
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
const plainSqlText = (node: Node, file: SourceFile) => {
  if (node.type === "Literal" && typeof node.value === "string") {
    const start = node.start + 1;
    return {
      sql: node.value,
      expressions: [],
      offsetAt: (index: number) => start + index,
    };
  }
  if (
    node.type === "TemplateLiteral" &&
    file.parents.get(node)?.type !== "TaggedTemplateExpression"
  ) {
    const { sql, offsets, expressions } = sqlParts(file, node);
    return {
      sql,
      expressions,
      offsetAt: (index: number) => offsets[index] ?? node.start,
    };
  }
  return undefined;
};

type ExpandedSqlOptions = {
  sql: string;
  expressions: Expression[];
  bindings: ConstBindings;
  file: SourceFile;
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
    const text = textOf(value, file);
    return value.type === "TaggedTemplateExpression" ||
      (isMember(value) &&
        (SOURCE_COLUMN.test(text) || value.property.name === "adapterKey")) ||
      (value.type === "Literal" &&
        typeof value.value === "number" &&
        value.value === 1) ||
      CORPUS_COUNT_TABLE.test(sqlTableName(text)) ||
      SOURCE_RELATION.test(text)
      ? text
      : marker;
  });

export const analyzeSqlPerf = (source: string, filename: string) => {
  const file = parseFile(filename, source);
  const bindings = constBindings(file);
  const imports = drizzleImports(file);
  const subqueryOperandContext = { imports, bindings, file };
  const rawHits: SqlPerfHit[] = [];
  const seen = new Set<string>();
  const add = (kind: SqlPerfHit["kind"], offset: number, holder: Node) => {
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
        location(file, holder.start).line,
        location(file, statementOf(holder, file).start).line,
      ],
    });
  };

  const inspectSql = (node: TaggedTemplateExpression) => {
    if (!isSqlTag(node)) {
      return;
    }
    const { sql, offsets, expressions } = sqlParts(file, node.quasi);
    if (fullSourceCount(expandedSql({ sql, expressions, bindings, file }))) {
      add("per-source-full-count", node.start, node);
    }
    for (const index of optionalKeysetOffsets(sql, expressions, file)) {
      add("optional-keyset", offsets[index] ?? node.start, node);
    }
    for (const index of sqlOrSubqueryOffsets(
      sqlWithoutLiterals(sql),
      expressions,
      bindings,
      file,
    )) {
      add("or-subquery", offsets[index] ?? node.start, node);
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
        lhsExpression === undefined ? lhs : textOf(lhsExpression, file);
      const offset = offsets[index] ?? node.start;
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
          containsCorpus(textOf(expression, file)),
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
          add("group-by-expression", offsets[cursor] ?? node.start, node);
        }
      }
    }
  };

  const visit = (node: Node) => {
    if (node.type === "TaggedTemplateExpression") {
      inspectSql(node);
    }
    const plain = plainSqlText(node, file);
    if (plain !== undefined) {
      const { sql, expressions } = plain;
      if (fullSourceCount(expandedSql({ sql, expressions, bindings, file }))) {
        add("per-source-full-count", node.start, node);
      }
      for (const index of optionalKeysetOffsets(plain.sql, [], file)) {
        add("optional-keyset", plain.offsetAt(index), node);
      }
    }
    if (node.type === "CallExpression") {
      if (drizzleSourceCount(node, subqueryOperandContext)) {
        add("per-source-full-count", node.start, node);
      }
      if (
        drizzleCallName(node, imports) === "or" &&
        node.arguments.some((argument) =>
          hasSubqueryOperand(argument, subqueryOperandContext),
        )
      ) {
        add("or-subquery", node.start, node);
      }
      if (isLikeCall(node) && node.arguments.length >= 2) {
        const column = node.arguments[0];
        const pattern = node.arguments[1];
        if (column !== undefined && S3_KEY.test(textOf(column, file))) {
          add("s3-key-like", node.start, node);
        }
        if (pattern !== undefined && startsWithWildcard(pattern, bindings)) {
          add("leading-wildcard", node.start, node);
        }
      }
      if (isGroupByCall(node)) {
        const receiver = textOf(node.callee.object, file);
        if (containsCorpus(receiver)) {
          for (const argument of node.arguments) {
            if (groupExpression(argument, bindings, file)) {
              add("group-by-expression", argument.start, node);
            }
          }
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(file.program);

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
