// Public-law data files read through the public-law reader connection, so
// they may only name the relations that reader is granted. Every other file
// is skipped, so the rule can be enabled for the whole API.
//
// The case-law data boundary: a file joins it by importing
// `@/api/lib/case-law-public-read-db` (type-only imports included); the
// connection module itself is always in it. Its schema imports come from the
// public-law relation map, `tx.query` names only the public relational
// queries, and its SQL text names no private table.
//
// Public-law SQL: a file joins by importing any owner of a public-law read —
// `@/api/lib/case-law-public-read-db`, `@/api/lib/legislation-public-read-db`,
// `@/api/lib/public-law-read-db` or `@/api/lib/public-law-shared-query` — and
// the owners are always in it. Each statement a `sql` template, a `sql.raw`
// string or a string `.execute()` spells is composed with the fragments this
// file writes (a fragment a statement interpolates is read in place), then
// tokenized: strings, quoted identifiers, dollar quotes and comments in one
// pass. Every relation in a FROM list (comma joins included) or after JOIN,
// quoted or schema-qualified, must be in the relation map, a CTE the same
// statement defines, or a system catalog. An interpolated relation must be a
// public schema table or a value the rule can enumerate, such as a parameter
// typed as a union of string literals.
//
// SQL spliced in as raw text must be something the rule can read: a literal,
// a constant, a parameter typed as a literal union, or a call to a reviewed
// scalar producer (`REVIEWED_SQL_PRODUCERS`, each with the reason it names no
// relation). Anything else is opaque executed SQL and is reported.
//
// What the rule does not see: a fragment imported from a module outside the
// boundary is read nowhere (its text lives in a file that imports no owner),
// and a query builder's `.from(table)` is checked only through the case-law
// boundary's schema-import allowlist, which legislation and shared-query
// files do not join. Lint is the early signal; the reader-role suite, which
// runs the registered queries as the role itself, is the proof.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT } from "../apps/api/src/lib/public-law-relations.ts";
import {
  type AstNode,
  canonicalModuleId,
  getImportedName,
  getPropertyName,
  isAstNode,
  isFileIn,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  isStringLiteral,
  repoRelativeFilename,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const PUBLIC_READ_DB_MODULE = "apps/api/src/lib/case-law-public-read-db";

// The modules that own a public-law read: the connection, the two branded
// corpus handles, and the registry of queries the reader-role suite runs.
const PUBLIC_LAW_BOUNDARY_OWNERS: readonly string[] = [
  PUBLIC_READ_DB_MODULE,
  "apps/api/src/lib/legislation-public-read-db",
  "apps/api/src/lib/public-law-read-db",
  "apps/api/src/lib/public-law-shared-query",
];

const SCHEMA_MODULE = "apps/api/src/db/schema";

/**
 * Functions whose string result may be spliced into public-law SQL as raw
 * text. Each renders a scalar expression over the column names its caller
 * passes as code constants, and names no relation.
 */
export const REVIEWED_SQL_PRODUCERS: readonly {
  modules: readonly string[];
  name: string;
  reason: string;
}[] = [
  {
    modules: ["apps/api/src/lib/case-law/court-weights"],
    name: "courtTierSqlFromMap",
    reason: "A CASE over the court registry's patterns; reads no relation.",
  },
  {
    modules: ["apps/api/src/lib/case-law/published-decisions"],
    name: "publishedCaseLawDecisionSqlFor",
    reason: "A predicate over the aliased decision's metadata column.",
  },
  {
    modules: [
      "apps/api/src/lib/case-law/redistribution",
      "apps/api/src/lib/case-law/redistribution-sql",
    ],
    name: "redistributableCaseLawSourceSqlFor",
    reason: "A predicate over the aliased source's descriptor column.",
  },
  {
    modules: ["apps/api/src/handlers/case-law/citation-score"],
    name: "polarityWeightSql",
    reason: "A CASE over a citation's polarity column.",
  },
  {
    modules: ["apps/api/src/handlers/case-law/citation-score"],
    name: "courtWeightSql",
    reason: "A CASE over the registry's patterns and a court column.",
  },
];

const PRIVATE_SQL_TOKEN_RE =
  /\b(?:workspace|workspaces|organization|organizations|entity|entities|field|fields|file|files|chat|user|session|account|matter|matters|task|tasks|contact|contacts)\b/iu;

// Every relation the public-law reader role is granted: the case-law tables
// and the public legislation tables read alongside them.
const PUBLIC_LAW_SCHEMA_IMPORT_SET: ReadonlySet<string> = new Set(
  Object.keys(PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT),
);

const PUBLIC_LAW_RELATION_SET: ReadonlySet<string> = new Set(
  Object.values(PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT),
);

const PUBLIC_CASE_LAW_QUERY_RELATIONS: ReadonlySet<string> = new Set([
  "caseLawDecisions",
]);

// Schema exports that are not tables: enum-like constants such as
// `SOURCE_TOTAL_ORIGIN`.
const CONSTANT_EXPORT_RE = /^[A-Z][A-Z0-9_]*$/u;

// Parents of a string literal that is not SQL text: a module specifier or a
// literal type.
const NON_SQL_LITERAL_PARENTS: ReadonlySet<string> = new Set([
  "ImportDeclaration",
  "ImportExpression",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "TSLiteralType",
  "TSExternalModuleReference",
]);

const MODULE_DECLARATIONS: ReadonlySet<string> = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
]);

// The catalogs every role reads; they hold no corpus data.
const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  "pg_catalog",
  "information_schema",
]);

// The canonical module a top-level import or re-export names.
const declaredModule = (
  statement: unknown,
  importerRepoPath: string,
): string | null =>
  isAstNode(statement) &&
  MODULE_DECLARATIONS.has(statement.type) &&
  isStringLiteral(statement.source)
    ? canonicalModuleId(statement.source.value, importerRepoPath)
    : null;

// Whether the program imports one of `owners`.
const importsPublicReadDb = (
  program: unknown,
  importerRepoPath: string,
  owners: readonly string[],
) =>
  isAstNode(program) &&
  Array.isArray(program.body) &&
  program.body.some((statement) => {
    const moduleId = declaredModule(statement, importerRepoPath);
    return moduleId !== null && owners.includes(moduleId);
  });

const getTxQueryObject = (node: unknown): AstNode | null => {
  const object = isAstNode(node) ? node.object : null;
  if (!isAstNode(object) || object.type !== "MemberExpression") {
    return null;
  }
  if (!isIdentifier(object.object, "tx")) {
    return null;
  }
  if (object.computed !== false) {
    return object;
  }
  return isIdentifier(object.property, "query") ? object : null;
};

const rawTemplateText = (node: unknown): string | null => {
  const value = isAstNode(node) ? node.value : null;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return "raw" in value && typeof value.raw === "string" ? value.raw : null;
};

const hasPrivateSqlText = (text: string): boolean =>
  PRIVATE_SQL_TOKEN_RE.test(text);

// --- SQL composition -----------------------------------------------------------

// One piece of a composed statement.
//
// - text: SQL the file writes, reported at `node`;
// - table: a schema table object interpolated by a `sql` template;
// - choice: a value the rule can enumerate (a literal-union parameter);
// - opaque: anything else, a bind parameter or a fragment built elsewhere.
type SqlPart =
  | { kind: "text"; text: string; node: AstNode }
  | { kind: "table"; name: string; public: boolean; node: AstNode }
  | { kind: "choice"; values: readonly string[]; node: AstNode }
  | { kind: "opaque"; node: AstNode };

type RuleContext = Parameters<typeof isImportedFrom>[0]["context"];

const MAX_COMPOSITION_DEPTH = 8;

const isSqlTag = (node: unknown): boolean =>
  isIdentifier(unwrapExpression(node), "sql");

// `sql.<method>(...)`
const isSqlMethodCall = (node: unknown, method: string): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    isSqlTag(callee.object) &&
    getPropertyName(callee.property) === method
  );
};

const firstArgument = (call: AstNode): AstNode | null =>
  Array.isArray(call.arguments) ? unwrapExpression(call.arguments.at(0)) : null;

const stringValues = (node: unknown): string[] | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "TSLiteralType") {
    return stringValues(node.literal);
  }
  if (isStringLiteral(node)) {
    return [node.value];
  }
  if (node.type === "TSUnionType" && Array.isArray(node.types)) {
    const values: string[] = [];
    for (const member of node.types) {
      const memberValues = stringValues(member);
      if (memberValues === null) {
        return null;
      }
      values.push(...memberValues);
    }
    return values;
  }
  return null;
};

// A parameter declared as a union of string literals: every value it can
// hold is written in its annotation.
const literalUnionParameter = (
  context: RuleContext,
  node: AstNode,
): string[] | null => {
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  const definition = variable?.defs.at(0);
  if (variable?.defs.length !== 1 || definition?.type !== "Parameter") {
    return null;
  }
  const annotation = isAstNode(definition.name)
    ? definition.name.typeAnnotation
    : null;
  return isAstNode(annotation) ? stringValues(annotation.typeAnnotation) : null;
};

const initializerOf = (context: RuleContext, node: AstNode): AstNode | null => {
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  return variable === null ? null : stableInitializer(variable);
};

const isReviewedProducerCall = (context: RuleContext, node: AstNode) =>
  node.type === "CallExpression" &&
  REVIEWED_SQL_PRODUCERS.some((producer) =>
    isImportedFrom({
      context,
      node: node.callee,
      modules: producer.modules,
      names: new Set([producer.name]),
    }),
  );

// `LIMIT`, `POLARITY.UNKNOWN`: a code constant, named in capitals.
const isConstantReference = (node: unknown): boolean => {
  let target = unwrapExpression(node);
  while (
    isAstNode(target) &&
    target.type === "MemberExpression" &&
    target.computed === false
  ) {
    target = unwrapExpression(target.object);
  }
  return isIdentifier(target) && CONSTANT_EXPORT_RE.test(target.name);
};

// `String(LIMIT)` or `String(LIMITS.name)`: a code constant rendered as text.
const isConstantString = (node: AstNode): boolean =>
  node.type === "CallExpression" &&
  isIdentifier(unwrapExpression(node.callee), "String") &&
  isConstantReference(firstArgument(node));

type RawText = { parts: SqlPart[] } | { opaque: AstNode };

/**
 * The text a raw-SQL argument can spell, or the node that makes it opaque.
 * Raw text is spliced into the statement unescaped, so every piece of it has
 * to be something the rule can read or enumerate.
 */
const rawText = (context: RuleContext, node: unknown, depth = 0): RawText => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression)) {
    return { parts: [] };
  }
  if (depth > MAX_COMPOSITION_DEPTH) {
    return { opaque: expression };
  }
  if (isStringLiteral(expression)) {
    return {
      parts: [{ kind: "text", text: expression.value, node: expression }],
    };
  }
  if (expression.type === "Literal" && typeof expression.value === "number") {
    return {
      parts: [
        { kind: "text", text: String(expression.value), node: expression },
      ],
    };
  }
  if (expression.type === "TemplateLiteral") {
    const parts: SqlPart[] = [];
    const quasis = Array.isArray(expression.quasis) ? expression.quasis : [];
    const expressions = Array.isArray(expression.expressions)
      ? expression.expressions
      : [];
    for (const [index, quasi] of quasis.entries()) {
      const text = rawTemplateText(quasi);
      if (isAstNode(quasi) && text !== null) {
        parts.push({ kind: "text", text, node: quasi });
      }
      const interpolated: unknown = expressions[index];
      if (isAstNode(interpolated)) {
        const inner = rawText(context, interpolated, depth + 1);
        if ("opaque" in inner) {
          return inner;
        }
        parts.push(...inner.parts);
      }
    }
    return { parts };
  }
  if (expression.type === "BinaryExpression" && expression.operator === "+") {
    const left = rawText(context, expression.left, depth + 1);
    if ("opaque" in left) {
      return left;
    }
    const right = rawText(context, expression.right, depth + 1);
    return "opaque" in right
      ? right
      : { parts: [...left.parts, ...right.parts] };
  }
  if (isReviewedProducerCall(context, expression)) {
    return { parts: [{ kind: "opaque", node: expression }] };
  }
  const values = literalUnionParameter(context, expression);
  if (values !== null) {
    return { parts: [{ kind: "choice", values, node: expression }] };
  }
  const initializer = initializerOf(context, expression);
  if (initializer !== null) {
    return rawText(context, initializer, depth + 1);
  }
  // An imported constant: reviewed code, but its text is not in this file,
  // so it stays unreadable where a relation belongs.
  if (isConstantString(expression) || isConstantReference(expression)) {
    return { parts: [{ kind: "opaque", node: expression }] };
  }
  return { opaque: expression };
};

type Composition = {
  parts: SqlPart[];
  // Nodes this composition read in place of a separate statement.
  inlined: Set<AstNode>;
  // Raw text the rule could not read.
  opaque: AstNode[];
};

/**
 * One statement as its text reads once the fragments the file writes are
 * put in place. A `sql` template interpolation is a bind value or a fragment;
 * a fragment defined in this file (directly or through a constant) is read in
 * place, a schema table is kept as a table, and anything else stays opaque.
 */
const compose = (context: RuleContext, root: AstNode): Composition => {
  const composition: Composition = {
    parts: [],
    inlined: new Set(),
    opaque: [],
  };
  const seen = new Set<AstNode>();

  const addRaw = (argument: unknown) => {
    const text = rawText(context, argument);
    if ("opaque" in text) {
      composition.opaque.push(text.opaque);
      composition.parts.push({ kind: "opaque", node: text.opaque });
      return;
    }
    composition.parts.push(...text.parts);
  };

  const addFragment = (node: AstNode, depth: number): boolean => {
    if (seen.has(node) || depth > MAX_COMPOSITION_DEPTH) {
      return false;
    }
    if (node.type === "TaggedTemplateExpression" && isSqlTag(node.tag)) {
      seen.add(node);
      addTemplate(node.quasi, depth);
      return true;
    }
    if (isSqlMethodCall(node, "raw")) {
      seen.add(node);
      addRaw(firstArgument(node));
      return true;
    }
    if (isSqlMethodCall(node, "identifier")) {
      const argument = firstArgument(node);
      if (isStringLiteral(argument)) {
        seen.add(node);
        composition.parts.push({
          kind: "text",
          text: `"${argument.value.replaceAll('"', '""')}"`,
          node: argument,
        });
        return true;
      }
    }
    return false;
  };

  const addExpression = (node: AstNode, depth: number) => {
    const expression = unwrapExpression(node) ?? node;
    if (addFragment(expression, depth + 1)) {
      composition.inlined.add(expression);
      return;
    }
    if (isIdentifierReference(expression)) {
      const schemaTable = isImportedFrom({
        context,
        node: expression,
        modules: [SCHEMA_MODULE],
        names: PUBLIC_LAW_SCHEMA_IMPORT_SET,
      });
      if (schemaTable) {
        composition.parts.push({
          kind: "table",
          name: expression.name,
          public: true,
          node: expression,
        });
        return;
      }
      const imported = isImportedFrom({
        context,
        node: expression,
        modules: [SCHEMA_MODULE],
        names: new Set([expression.name]),
      });
      if (imported) {
        composition.parts.push({
          kind: "table",
          name: expression.name,
          public: false,
          node: expression,
        });
        return;
      }
      const initializer = initializerOf(context, expression);
      if (initializer !== null && addFragment(initializer, depth + 1)) {
        composition.inlined.add(initializer);
        return;
      }
    }
    composition.parts.push({ kind: "opaque", node: expression });
  };

  const addTemplate = (template: unknown, depth: number) => {
    if (!isAstNode(template) || template.type !== "TemplateLiteral") {
      return;
    }
    const quasis = Array.isArray(template.quasis) ? template.quasis : [];
    const expressions = Array.isArray(template.expressions)
      ? template.expressions
      : [];
    for (const [index, quasi] of quasis.entries()) {
      const text = rawTemplateText(quasi);
      if (isAstNode(quasi) && text !== null) {
        composition.parts.push({ kind: "text", text, node: quasi });
      }
      const expression: unknown = expressions[index];
      if (isAstNode(expression)) {
        addExpression(expression, depth);
      }
    }
  };

  if (!addFragment(root, 0)) {
    // A string handed to `.execute()`: raw text, like a `sql.raw` argument.
    addRaw(root);
  }
  return composition;
};

// --- SQL tokens ------------------------------------------------------------------

type SqlToken =
  | { kind: "word"; value: string; owner: SqlPart }
  | { kind: "quoted"; value: string; owner: SqlPart }
  | { kind: "punct"; value: string; owner: SqlPart }
  | { kind: "part"; owner: SqlPart };

const isWordStart = (char: string): boolean =>
  (char >= "a" && char <= "z") ||
  (char >= "A" && char <= "Z") ||
  char === "_" ||
  char > "\u007f";

const isWordChar = (char: string): boolean =>
  isWordStart(char) || (char >= "0" && char <= "9") || char === "$";

// The end of a `$tag$ ... $tag$` quote starting at `start`, or -1.
const dollarQuoteEnd = (text: string, start: number): number => {
  let tagEnd = start + 1;
  while (
    tagEnd < text.length &&
    isWordChar(text.charAt(tagEnd)) &&
    text.charAt(tagEnd) !== "$"
  ) {
    tagEnd += 1;
  }
  if (text.charAt(tagEnd) !== "$") {
    return -1;
  }
  const tag = text.slice(start, tagEnd + 1);
  const close = text.indexOf(tag, tagEnd + 1);
  return close === -1 ? text.length : close + tag.length;
};

/**
 * One pass over a composed statement. Strings (with `''` and, in `E''`
 * strings, backslash escapes), quoted identifiers, dollar quotes and both
 * comment forms are consumed where they start, so none of them can hide or
 * forge a keyword.
 */
const tokenize = (parts: readonly SqlPart[]): SqlToken[] => {
  const tokens: SqlToken[] = [];
  for (const part of parts) {
    if (part.kind !== "text") {
      tokens.push({ kind: "part", owner: part });
      continue;
    }
    const text = part.text;
    let index = 0;
    while (index < text.length) {
      const char = text.charAt(index);
      const next = text.charAt(index + 1);
      if (char === "-" && next === "-") {
        const newline = text.indexOf("\n", index);
        index = newline === -1 ? text.length : newline + 1;
      } else if (char === "/" && next === "*") {
        let depth = 1;
        index += 2;
        while (index < text.length && depth > 0) {
          if (text.startsWith("/*", index)) {
            depth += 1;
            index += 2;
          } else if (text.startsWith("*/", index)) {
            depth -= 1;
            index += 2;
          } else {
            index += 1;
          }
        }
      } else if (char === "'") {
        const escapes =
          index > 0 &&
          (text.charAt(index - 1) === "E" || text.charAt(index - 1) === "e") &&
          (index < 2 || !isWordChar(text.charAt(index - 2)));
        index += 1;
        while (index < text.length) {
          const inner = text.charAt(index);
          if (escapes && inner === "\\") {
            index += 2;
          } else if (inner === "'" && text.charAt(index + 1) === "'") {
            index += 2;
          } else if (inner === "'") {
            index += 1;
            break;
          } else {
            index += 1;
          }
        }
      } else if (char === '"') {
        let value = "";
        index += 1;
        while (index < text.length) {
          const inner = text.charAt(index);
          if (inner === '"' && text.charAt(index + 1) === '"') {
            value += '"';
            index += 2;
          } else if (inner === '"') {
            index += 1;
            break;
          } else {
            value += inner;
            index += 1;
          }
        }
        tokens.push({ kind: "quoted", value, owner: part });
      } else if (char === "$" && !(next >= "0" && next <= "9")) {
        const end = dollarQuoteEnd(text, index);
        if (end === -1) {
          tokens.push({ kind: "punct", value: char, owner: part });
          index += 1;
        } else {
          index = end;
        }
      } else if (isWordStart(char)) {
        let end = index + 1;
        while (end < text.length && isWordChar(text.charAt(end))) {
          end += 1;
        }
        tokens.push({
          kind: "word",
          value: text.slice(index, end).toLowerCase(),
          owner: part,
        });
        index = end;
      } else if (char.trim() === "") {
        index += 1;
      } else {
        tokens.push({ kind: "punct", value: char, owner: part });
        index += 1;
      }
    }
  }
  return tokens;
};

// --- Relation scan ---------------------------------------------------------------

// Functions whose arguments spell FROM without naming a relation.
const FROM_ARGUMENT_FUNCTIONS: ReadonlySet<string> = new Set([
  "extract",
  "substring",
  "trim",
  "overlay",
  "position",
]);

// Words that end a table reference instead of aliasing it.
const REFERENCE_TERMINATORS: ReadonlySet<string> = new Set([
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "natural",
  "on",
  "using",
  "group",
  "order",
  "limit",
  "offset",
  "fetch",
  "having",
  "window",
  "union",
  "except",
  "intersect",
  "for",
  "returning",
  "select",
  "lateral",
  "tablesample",
  "with",
]);

type RelationReference =
  | { kind: "name"; schema: string | null; relation: string; token: SqlToken }
  | { kind: "part"; part: SqlPart };

const isPunct = (token: SqlToken | undefined, value: string): boolean =>
  token?.kind === "punct" && token.value === value;

const isWord = (token: SqlToken | undefined, value: string): boolean =>
  token?.kind === "word" && token.value === value;

const nameOf = (token: SqlToken | undefined): string | null =>
  token?.kind === "word" || token?.kind === "quoted" ? token.value : null;

// The index just past the parenthesis group opening at `open`.
const skipGroup = (tokens: readonly SqlToken[], open: number): number => {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (isPunct(tokens[index], "(")) {
      depth += 1;
    } else if (isPunct(tokens[index], ")")) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return tokens.length;
};

/**
 * The table references a FROM list or a JOIN starting at `start` names. A
 * subquery or a set-returning function names none of its own here; the scan
 * still walks its tokens. FROM lists continue past commas.
 */
const tableReferences = (
  tokens: readonly SqlToken[],
  start: number,
  list: boolean,
): RelationReference[] => {
  const references: RelationReference[] = [];
  let index = start;
  for (;;) {
    while (isWord(tokens[index], "lateral") || isWord(tokens[index], "only")) {
      index += 1;
    }
    const token = tokens[index];
    if (token === undefined) {
      return references;
    }
    if (isPunct(token, "(")) {
      index = skipGroup(tokens, index);
    } else if (token.kind === "part") {
      references.push({ kind: "part", part: token.owner });
      index += 1;
    } else {
      const first = nameOf(token);
      if (first === null) {
        return references;
      }
      let schema: string | null = null;
      let relation = first;
      let nameToken: SqlToken = token;
      index += 1;
      if (isPunct(tokens[index], ".")) {
        const second = tokens[index + 1];
        const secondName = nameOf(second);
        if (second === undefined || secondName === null) {
          return references;
        }
        schema = first;
        relation = secondName;
        nameToken = second;
        index += 2;
      }
      if (isPunct(tokens[index], "(")) {
        // A set-returning function, not a relation.
        index = skipGroup(tokens, index);
      } else {
        references.push({ kind: "name", schema, relation, token: nameToken });
      }
    }
    // An optional alias and column list.
    if (isWord(tokens[index], "as")) {
      index += 1;
    }
    const alias = tokens[index];
    if (
      alias?.kind === "quoted" ||
      (alias?.kind === "word" && !REFERENCE_TERMINATORS.has(alias.value))
    ) {
      index += 1;
      if (isPunct(tokens[index], "(")) {
        index = skipGroup(tokens, index);
      }
    }
    if (!list || !isPunct(tokens[index], ",")) {
      return references;
    }
    index += 1;
  }
};

/** Every relation reference in a composed statement, and the CTEs it defines. */
const statementReferences = (
  tokens: readonly SqlToken[],
): { references: RelationReference[]; ctes: Set<string> } => {
  const references: RelationReference[] = [];
  const ctes = new Set<string>();
  // The function each open parenthesis belongs to, innermost last.
  const calls: (string | null)[] = [];
  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1];
    if (isPunct(token, "(")) {
      calls.push(previous?.kind === "word" ? previous.value : null);
      continue;
    }
    if (isPunct(token, ")")) {
      calls.pop();
      continue;
    }
    if (token.kind !== "word") {
      continue;
    }
    if (token.value === "as") {
      // `name AS (`, `name(columns) AS (`, `... AS [NOT] MATERIALIZED (`.
      let after = index + 1;
      while (
        isWord(tokens[after], "not") ||
        isWord(tokens[after], "materialized")
      ) {
        after += 1;
      }
      if (isPunct(tokens[after], "(")) {
        let nameIndex = index - 1;
        if (isPunct(tokens[nameIndex], ")")) {
          let depth = 0;
          for (; nameIndex >= 0; nameIndex -= 1) {
            if (isPunct(tokens[nameIndex], ")")) {
              depth += 1;
            } else if (isPunct(tokens[nameIndex], "(")) {
              depth -= 1;
              if (depth === 0) {
                break;
              }
            }
          }
          nameIndex -= 1;
        }
        const name = nameOf(tokens[nameIndex]);
        if (name !== null) {
          ctes.add(name);
        }
      }
      continue;
    }
    if (token.value === "join") {
      references.push(...tableReferences(tokens, index + 1, false));
      continue;
    }
    if (token.value !== "from") {
      continue;
    }
    const call = calls.at(-1);
    if (
      (call !== undefined &&
        call !== null &&
        FROM_ARGUMENT_FUNCTIONS.has(call)) ||
      isWord(previous, "distinct")
    ) {
      continue;
    }
    references.push(...tableReferences(tokens, index + 1, true));
  }
  return { references, ctes };
};

const isGrantedRelation = (
  schema: string | null,
  relation: string,
  ctes: ReadonlySet<string>,
): boolean => {
  if (schema !== null) {
    return (
      SYSTEM_SCHEMAS.has(schema) ||
      (schema === "public" && PUBLIC_LAW_RELATION_SET.has(relation))
    );
  }
  return (
    relation.startsWith("pg_") ||
    PUBLIC_LAW_RELATION_SET.has(relation) ||
    ctes.has(relation)
  );
};

const reportNode = (owner: SqlPart): AstNode => owner.node;

// A `.execute(...)` whose argument is a string: text the driver runs as is.
const executedString = (node: unknown): AstNode | null => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  if (
    !isAstNode(callee) ||
    callee.type !== "MemberExpression" ||
    getPropertyName(callee.property) !== "execute"
  ) {
    return null;
  }
  const argument = firstArgument(node);
  return isAstNode(argument) &&
    (isStringLiteral(argument) ||
      argument.type === "TemplateLiteral" ||
      argument.type === "BinaryExpression")
    ? argument
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "public-case-law-db-boundary" },
  rules: {
    "public-case-law-db-boundary": {
      meta: {
        type: "problem",
        messages: {
          privateCaseLawImport:
            "Public case-law data files may only import the explicit public-law table allowlist from '@/api/db/schema'.",
          privateTxQuery:
            "Public case-law data files may only use the explicit public tx.query relation allowlist.",
          privateSqlText:
            "Public case-law SQL must not mention private workspace, user, organization, matter, file, chat, task, or contact tables.",
          unlistedRelation:
            "Public-law SQL may only read relations in the public-law relation map (`public-law-relations.ts`), a CTE the same statement defines, or a system catalog; '{{relation}}' is none of them.",
          uninspectableRelation:
            "Public-law SQL must name the relation it reads: a public schema table, a fragment written in this file, or a value the rule can enumerate.",
          opaqueSql:
            "Raw SQL in a public-law read must be text the rule can read: a literal, a code constant, a literal-union parameter, or a reviewed producer in REVIEWED_SQL_PRODUCERS.",
        },
      },
      createOnce(context) {
        // The case-law data boundary: schema imports, `tx.query` and private
        // SQL text are checked here.
        let inBoundary = false;
        // Every public-law read: the SQL it runs is checked here.
        let readsPublicLaw = false;
        let importerRepoPath = "";
        let candidates: AstNode[] = [];
        let executedStrings: AstNode[] = [];

        const checkReference = (
          reference: RelationReference,
          ctes: ReadonlySet<string>,
        ) => {
          if (reference.kind === "name") {
            if (
              !isGrantedRelation(reference.schema, reference.relation, ctes)
            ) {
              context.report({
                node: reportNode(reference.token.owner),
                messageId: "unlistedRelation",
                data: {
                  relation:
                    reference.schema === null
                      ? reference.relation
                      : `${reference.schema}.${reference.relation}`,
                },
              });
            }
            return;
          }
          const part = reference.part;
          if (part.kind === "table") {
            if (!part.public) {
              context.report({
                node: part.node,
                messageId: "unlistedRelation",
                data: { relation: part.name },
              });
            }
            return;
          }
          if (part.kind === "choice") {
            for (const value of part.values) {
              if (!isGrantedRelation(null, value.toLowerCase(), ctes)) {
                context.report({
                  node: part.node,
                  messageId: "unlistedRelation",
                  data: { relation: value },
                });
              }
            }
            return;
          }
          context.report({
            node: part.node,
            messageId: "uninspectableRelation",
          });
        };

        return {
          before() {
            importerRepoPath = repoRelativeFilename(context);
            inBoundary = false;
            readsPublicLaw = false;
            candidates = [];
            executedStrings = [];
          },
          Program(node) {
            inBoundary =
              isFileIn(context, [`${PUBLIC_READ_DB_MODULE}.ts`]) ||
              importsPublicReadDb(node, importerRepoPath, [
                PUBLIC_READ_DB_MODULE,
              ]);
            readsPublicLaw =
              isFileIn(
                context,
                PUBLIC_LAW_BOUNDARY_OWNERS.map((owner) => `${owner}.ts`),
              ) ||
              importsPublicReadDb(
                node,
                importerRepoPath,
                PUBLIC_LAW_BOUNDARY_OWNERS,
              );
          },
          ImportDeclaration(node) {
            if (
              !inBoundary ||
              declaredModule(node, importerRepoPath) !== SCHEMA_MODULE
            ) {
              return;
            }
            if (node.importKind === "type") {
              return;
            }
            for (const specifier of node.specifiers) {
              const imported = getImportedName(specifier);
              if (
                (isAstNode(specifier) && specifier.importKind === "type") ||
                (imported !== null &&
                  (PUBLIC_LAW_SCHEMA_IMPORT_SET.has(imported) ||
                    CONSTANT_EXPORT_RE.test(imported)))
              ) {
                continue;
              }
              context.report({
                node: specifier,
                messageId: "privateCaseLawImport",
              });
            }
          },
          MemberExpression(node) {
            if (!inBoundary) {
              return;
            }
            const queryObject = getTxQueryObject(node);
            if (queryObject === null) {
              return;
            }
            const propertyName = getPropertyName(node.property);
            if (
              queryObject.computed !== false ||
              propertyName === null ||
              !PUBLIC_CASE_LAW_QUERY_RELATIONS.has(propertyName)
            ) {
              context.report({ node, messageId: "privateTxQuery" });
            }
          },
          TaggedTemplateExpression(node) {
            if (readsPublicLaw && isAstNode(node) && isSqlTag(node.tag)) {
              candidates.push(node);
            }
          },
          CallExpression(node) {
            if (!readsPublicLaw || !isAstNode(node)) {
              return;
            }
            if (isSqlMethodCall(node, "raw")) {
              candidates.push(node);
              return;
            }
            const executed = executedString(node);
            if (executed !== null) {
              executedStrings.push(executed);
            }
          },
          Literal(node) {
            const parent = node.parent;
            if (
              inBoundary &&
              !(
                isAstNode(parent) && NON_SQL_LITERAL_PARENTS.has(parent.type)
              ) &&
              typeof node.value === "string" &&
              hasPrivateSqlText(node.value)
            ) {
              context.report({ node, messageId: "privateSqlText" });
            }
          },
          TemplateElement(node) {
            if (!inBoundary) {
              return;
            }
            const raw = rawTemplateText(node);
            if (raw !== null && hasPrivateSqlText(raw)) {
              context.report({ node, messageId: "privateSqlText" });
            }
          },
          "Program:exit"() {
            if (!readsPublicLaw) {
              return;
            }
            const compositions = new Map<AstNode, Composition>();
            const inlined = new Set<AstNode>();
            for (const candidate of [...candidates, ...executedStrings]) {
              const composition = compose(context, candidate);
              compositions.set(candidate, composition);
              for (const node of composition.inlined) {
                inlined.add(node);
              }
            }
            const reportedOpaque = new Set<AstNode>();
            for (const [root, composition] of compositions) {
              for (const node of composition.opaque) {
                if (!reportedOpaque.has(node)) {
                  reportedOpaque.add(node);
                  context.report({ node, messageId: "opaqueSql" });
                }
              }
              if (inlined.has(root)) {
                continue;
              }
              const { references, ctes } = statementReferences(
                tokenize(composition.parts),
              );
              for (const reference of references) {
                checkReference(reference, ctes);
              }
            }
          },
        };
      },
    },
  },
});
