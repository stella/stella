// Public case-law data files read through the public-law reader connection,
// so they may only name the public case-law tables. A file joins the boundary
// by importing `@/api/lib/case-law-public-read-db` (type-only imports
// included); the connection module itself is always in it. Every other file
// is skipped, so the rule can be enabled for the whole API.

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
  isStringLiteral,
  repoRelativeFilename,
} from "./utils.ts";

const PUBLIC_READ_DB_MODULE = "apps/api/src/lib/case-law-public-read-db";
const SCHEMA_MODULE = "apps/api/src/db/schema";

const PRIVATE_SQL_TOKEN_RE =
  /\b(?:workspace|workspaces|organization|organizations|entity|entities|field|fields|file|files|chat|user|session|account|matter|matters|task|tasks|contact|contacts)\b/iu;

// Every relation the public-law reader role is granted: the case-law tables
// and the public legislation tables read alongside them.
const PUBLIC_LAW_SCHEMA_IMPORT_SET: ReadonlySet<string> = new Set(
  Object.keys(PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT),
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

// Whether the program imports the public read connection.
const importsPublicReadDb = (program: unknown, importerRepoPath: string) =>
  isAstNode(program) &&
  Array.isArray(program.body) &&
  program.body.some(
    (statement) =>
      declaredModule(statement, importerRepoPath) === PUBLIC_READ_DB_MODULE,
  );

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
        },
      },
      createOnce(context) {
        let inBoundary = false;
        let importerRepoPath = "";

        return {
          before() {
            importerRepoPath = repoRelativeFilename(context);
            inBoundary = false;
          },
          Program(node) {
            inBoundary =
              isFileIn(context, [`${PUBLIC_READ_DB_MODULE}.ts`]) ||
              importsPublicReadDb(node, importerRepoPath);
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
        };
      },
    },
  },
});
