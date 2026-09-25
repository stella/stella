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
// Every public-law read: a file joins by importing any owner of one —
// `@/api/lib/case-law-public-read-db`, `@/api/lib/legislation-public-read-db`,
// `@/api/lib/public-law-read-db` or `@/api/lib/public-law-shared-query` — and
// the owners are always in it. Every relation a `sql` template or a `sql.raw`
// string reads (after FROM or JOIN, quoted or schema-qualified) is in the
// relation map, a CTE the file defines, or a system catalog. An interpolation
// in that position must be a public schema table or a SQL fragment this file
// writes, whose own text the rule reads; anything else is a relation the rule
// cannot see, and needs a reviewed suppression that names what it reads.
//
// Lint is the early signal. The reader-role suite, which runs the registered
// queries as the role itself, is the proof.

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

// --- SQL relation scan -------------------------------------------------------

// One piece of SQL as the file writes it: literal text, or an interpolation
// whose value the scan cannot read.
type SqlPart =
  | { kind: "text"; text: string; node: AstNode }
  | { kind: "expression"; node: AstNode };

// Stands in for an interpolation in the flattened text. A private-use
// character never appears in SQL the files write.
const EXPRESSION_MARK = "";

// Comments and string literals are blanked to spaces of the same length, so
// offsets still map back to the part that holds them.
const blank = (match: string): string => " ".repeat(match.length);
const SQL_COMMENT_RE = /--[^\n]*|\/\*[\S\s]*?\*\//gu;
const SQL_STRING_RE = /'(?:[^']|'')*'/gu;

// `name AS (`, `name(columns) AS (` and the MATERIALIZED spellings: a CTE,
// wherever the file writes it. A fragment can define a CTE that another
// template reads, so the names are collected across the whole file.
const CTE_RE =
  /(?<name>[a-z_][a-z0-9_]*)\s*(?:\([^()]*\))?\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/giu;

// FROM and JOIN in a position that names a relation. The functions whose
// arguments spell FROM (`extract(year FROM x)`, `substring(x FROM 1)`) and
// `IS DISTINCT FROM` do not.
const RELATION_KEYWORD_RE = /\b(?:from|join)\b/giu;
const NON_RELATION_FROM_RE =
  /(?:\b(?:extract|substring|trim|overlay|position)\s*\([^()]*|\bdistinct\s+)$/iu;
const RELATION_PREFIX_RE = /^\s*(?:(?:lateral|only)\b\s*)*/iu;
const IDENTIFIER_SOURCE = String.raw`(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`;
const QUALIFIED_NAME_RE = new RegExp(
  String.raw`^(?<first>${IDENTIFIER_SOURCE})(?:\s*\.\s*(?<second>${IDENTIFIER_SOURCE}))?(?<call>\s*\()?`,
  "iu",
);

const identifierName = (spelled: string): string =>
  spelled.startsWith('"')
    ? spelled.slice(1, -1).replaceAll('""', '"')
    : spelled.toLowerCase();

type RelationReference =
  | { kind: "name"; schema: string | null; relation: string; part: SqlPart }
  | { kind: "expression"; part: SqlPart };

type FlatSql = {
  text: string;
  // The part each character of `text` came from.
  owners: SqlPart[];
};

const flattenSql = (parts: readonly SqlPart[]): FlatSql => {
  let text = "";
  const owners: SqlPart[] = [];
  for (const part of parts) {
    const piece =
      part.kind === "text"
        ? part.text.replace(SQL_COMMENT_RE, blank).replace(SQL_STRING_RE, blank)
        : EXPRESSION_MARK;
    text += piece;
    owners.push(...Array.from({ length: piece.length }, () => part));
  }
  return { text, owners };
};

const cteNamesIn = (parts: readonly SqlPart[]): string[] =>
  [...flattenSql(parts).text.matchAll(CTE_RE)].flatMap((match) =>
    match.groups?.name === undefined ? [] : [match.groups.name.toLowerCase()],
  );

const relationReferences = (parts: readonly SqlPart[]): RelationReference[] => {
  const { text, owners } = flattenSql(parts);
  const references: RelationReference[] = [];
  for (const keyword of text.matchAll(RELATION_KEYWORD_RE)) {
    const before = text.slice(Math.max(0, keyword.index - 200), keyword.index);
    if (NON_RELATION_FROM_RE.test(before)) {
      continue;
    }
    let position = keyword.index + keyword[0].length;
    position += RELATION_PREFIX_RE.exec(text.slice(position))?.[0].length ?? 0;
    const next = text.charAt(position);
    const owner = owners[position];
    if (next === "" || next === "(" || owner === undefined) {
      continue;
    }
    if (next === EXPRESSION_MARK) {
      references.push({ kind: "expression", part: owner });
      continue;
    }
    const name = QUALIFIED_NAME_RE.exec(text.slice(position));
    const first = name?.groups?.first;
    if (first === undefined || name?.groups?.call !== undefined) {
      // A set-returning function (`jsonb_array_elements(...)`) or nothing
      // that spells a name.
      continue;
    }
    const second = name?.groups?.second;
    references.push(
      second === undefined
        ? {
            kind: "name",
            schema: null,
            relation: identifierName(first),
            part: owner,
          }
        : {
            kind: "name",
            schema: identifierName(first),
            relation: identifierName(second),
            part: owner,
          },
    );
  }
  return references;
};

const isGrantedRelation = (
  schema: string | null,
  relation: string,
  cteNames: ReadonlySet<string>,
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
    cteNames.has(relation)
  );
};

const isSqlTag = (node: unknown): boolean =>
  isIdentifier(unwrapExpression(node), "sql");

// `sql.raw(...)`
const isSqlRawCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    isSqlTag(callee.object) &&
    getPropertyName(callee.property) === "raw"
  );
};

// The SQL a template literal spells, interpolations kept apart.
const templateParts = (template: unknown): SqlPart[] => {
  if (!isAstNode(template) || template.type !== "TemplateLiteral") {
    return [];
  }
  const quasis = Array.isArray(template.quasis) ? template.quasis : [];
  const expressions = Array.isArray(template.expressions)
    ? template.expressions
    : [];
  const parts: SqlPart[] = [];
  for (const [index, quasi] of quasis.entries()) {
    const text = rawTemplateText(quasi);
    if (isAstNode(quasi) && text !== null) {
      parts.push({ kind: "text", text, node: quasi });
    }
    const expression: unknown = expressions[index];
    if (isAstNode(expression)) {
      parts.push({ kind: "expression", node: expression });
    }
  }
  return parts;
};

// The SQL a `sql.raw` argument spells, when the file writes it out.
const rawCallParts = (call: unknown): SqlPart[] | null => {
  if (!isAstNode(call)) {
    return null;
  }
  const argument = Array.isArray(call.arguments)
    ? unwrapExpression(call.arguments.at(0))
    : null;
  if (isStringLiteral(argument)) {
    return [{ kind: "text", text: argument.value, node: argument }];
  }
  if (isAstNode(argument) && argument.type === "TemplateLiteral") {
    return templateParts(argument);
  }
  return null;
};

// SQL this file writes out, whose text the scan reads where it is written.
const isInspectableSqlFragment = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression)) {
    return false;
  }
  if (expression.type === "TaggedTemplateExpression") {
    return isSqlTag(expression.tag);
  }
  return isSqlRawCall(expression) && rawCallParts(expression) !== null;
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
            "Public-law SQL may only read relations in the public-law relation map (`public-law-relations.ts`), a CTE this file defines, or a system catalog; '{{relation}}' is none of them.",
          uninspectableRelation:
            "Public-law SQL must name the relation it reads: a public schema table, or a SQL fragment written in this file. Any other value needs a reviewed suppression naming the relations it reads.",
        },
      },
      createOnce(context) {
        // The case-law data boundary: schema imports, `tx.query` and private
        // SQL text are checked here.
        let inBoundary = false;
        // Every public-law read: the relations its SQL names are checked here.
        let readsPublicLaw = false;
        let importerRepoPath = "";
        let sqlSources: SqlPart[][] = [];

        // An interpolation in a relation position the scan can vouch for.
        const isKnownRelationExpression = (node: unknown): boolean => {
          const expression = unwrapExpression(node);
          if (
            isImportedFrom({
              context,
              node: expression,
              modules: [SCHEMA_MODULE],
              names: PUBLIC_LAW_SCHEMA_IMPORT_SET,
            })
          ) {
            return true;
          }
          if (isInspectableSqlFragment(expression)) {
            return true;
          }
          if (!isIdentifierReference(expression)) {
            return false;
          }
          const variable = resolveVariable(context, expression);
          return (
            variable !== null &&
            isInspectableSqlFragment(stableInitializer(variable))
          );
        };

        return {
          before() {
            importerRepoPath = repoRelativeFilename(context);
            inBoundary = false;
            readsPublicLaw = false;
            sqlSources = [];
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
            if (readsPublicLaw && isSqlTag(node.tag)) {
              sqlSources.push(templateParts(node.quasi));
            }
          },
          CallExpression(node) {
            if (!readsPublicLaw || !isSqlRawCall(node)) {
              return;
            }
            const parts = rawCallParts(node);
            if (parts !== null) {
              sqlSources.push(parts);
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
            const cteNames = new Set(sqlSources.flatMap(cteNamesIn));
            for (const parts of sqlSources) {
              for (const reference of relationReferences(parts)) {
                if (reference.kind === "expression") {
                  if (!isKnownRelationExpression(reference.part.node)) {
                    context.report({
                      node: reference.part.node,
                      messageId: "uninspectableRelation",
                    });
                  }
                  continue;
                }
                if (
                  !isGrantedRelation(
                    reference.schema,
                    reference.relation,
                    cteNames,
                  )
                ) {
                  context.report({
                    node: reference.part.node,
                    messageId: "unlistedRelation",
                    data: {
                      relation:
                        reference.schema === null
                          ? reference.relation
                          : `${reference.schema}.${reference.relation}`,
                    },
                  });
                }
              }
            }
          },
        };
      },
    },
  },
});
