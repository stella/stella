// Keep new decision and supplement payloads at the typed validated writers.
// Null clears, canonical trim columns, and explicit confirmed corpus-pointer
// relocation are separate operations; no file-wide repair-script exemption.
import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import {
  type AstNode,
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  isTestFile,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-direct-case-law-text-write";
// Decision writers require the final-payload brand. Supplement placement
// requires a separate staged-assessment brand before an owner is selected;
// the final composition then crosses the validated decision writer.
// Expanding this set requires the owning operation's typed contract.
const PAYLOAD_OWNERS = [
  "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts",
  "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row-update.ts",
  "apps/api/src/lib/legal-search/text-retention/deferred-document.ts",
  "apps/api/src/handlers/case-law/ingestion/pipeline/supplement-placement.ts",
] as const;
const MIRROR_OWNERS = [
  "apps/api/src/handlers/case-law/ingestion/pipeline/corpus-mirror.ts",
  "apps/api/src/scripts/backfill-corpus-storage.ts",
] as const;
// Local seed rows are checked-in fixtures without a captured raw source.
// This exact nonproduction entrypoint cannot stand in for a repair writer.
const FIXTURE_SEED_OWNER = "apps/api/scripts/seed-case-law.ts";
const CORPUS_MODULE = "apps/api/src/lib/legal-search/corpus-storage";
const RAW_STORAGE_MODULE = "apps/api/src/lib/legal-search/raw-source-storage";
const TABLES = new Set(["caseLawDecisions", "caseLawDecisionSupplements"]);
const PROTECTED_COLUMNS = new Set(
  Object.keys({
    fulltext: null,
    sections: null,
    documentAst: null,
    sourceRaw: null,
    sourceRawContentType: null,
    sourceRawS3Key: null,
    textS3Key: null,
    normalizedS3Key: null,
    astS3Key: null,
    contentHash: null,
    sourceHash: null,
    parserVersion: null,
  }),
);
const SQL_COLUMNS =
  /\b(?:fulltext|sections|document_ast|source_raw(?:_s3_key|_content_type)?|text_s3_key|normalized_s3_key|ast_s3_key|content_hash|source_hash|parser_version)\b/iu;
const MAX_AST_DEPTH = 64;

const isSchemaModule = (moduleId: string) =>
  moduleId === "apps/api/src/db/schema" ||
  moduleId === "apps/api/src/db/schema/case-law";

const isNull = (node: unknown) => {
  const value = unwrapExpression(node);
  return value?.type === "Literal" && value.value === null;
};

const isEmptyObject = (node: unknown) => {
  const value = unwrapExpression(node);
  return (
    value?.type === "ObjectExpression" &&
    Array.isArray(value.properties) &&
    value.properties.length === 0
  );
};

const sqlWritesPayload = (source: string) => {
  const text = source.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/gu, " ");
  const mutation =
    /\b(?:UPDATE\s+(?:"?\w+"?\.)?"?case_law_(?:decisions|decision_supplements)"?\b[\s\S]*?\bSET\b(?<assignments>[\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;|$)|INSERT\s+INTO\s+(?:"?\w+"?\.)?"?case_law_(?:decisions|decision_supplements)"?\s*\((?<columns>[^)]*)\))/giu;
  for (const match of text.matchAll(mutation)) {
    const columns = match.groups?.columns;
    if (
      columns !== undefined &&
      (SQL_COLUMNS.test(columns) || columns.includes("?"))
    ) {
      return true;
    }
    const assignments = match.groups?.assignments;
    if (assignments === undefined) {
      continue;
    }
    // An interpolated assignment target is opaque. Values may still be
    // parameterized when their static target is an unrelated metadata field.
    if (/(?:^|,)\s*\?/u.test(assignments)) {
      return true;
    }
    const protectedAssignments =
      /(?:^|,)\s*"?(?:fulltext|sections|document_ast|source_raw(?:_s3_key|_content_type)?|text_s3_key|normalized_s3_key|ast_s3_key|content_hash|source_hash|parser_version)"?\s*=\s*(?<clear>NULL\s*(?=,|$))?/giu;
    if (
      Array.from(assignments.matchAll(protectedAssignments)).some(
        (assignment) => assignment.groups?.clear === undefined,
      )
    ) {
      return true;
    }
    for (const tuple of assignments.matchAll(/\((?<columns>[^)]*)\)\s*=/gu)) {
      if (SQL_COLUMNS.test(tuple.groups?.columns ?? "")) {
        return true;
      }
    }
  }
  return false;
};

type ResolveValueOptions = {
  context: Parameters<typeof resolveImport>[0];
  node: unknown;
};

const resolvedValue = ({
  context,
  node,
}: ResolveValueOptions): AstNode | null => {
  const value = unwrapExpression(node);
  if (!isIdentifierReference(value)) {
    return value;
  }
  const variable = resolveVariable(context, value);
  return variable === null ? value : (stableInitializer(variable) ?? value);
};

type OwnsMutationOptions = ResolveValueOptions & { depth?: number };

const ownsMutation = ({
  context,
  node,
  depth = 0,
}: OwnsMutationOptions): boolean => {
  if (depth > MAX_AST_DEPTH) {
    return false;
  }
  const expression = resolvedValue({ context, node });
  if (expression?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(expression.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method === "update" || method === "insert") {
    const table = Array.isArray(expression.arguments)
      ? resolveImport(context, expression.arguments.at(0))
      : null;
    return (
      table !== null &&
      isSchemaModule(table.moduleId) &&
      TABLES.has(table.imported)
    );
  }
  return ownsMutation({ context, node: callee.object, depth: depth + 1 });
};

type IsCorpusExportOptions = ResolveValueOptions & { name: string };

const isCorpusExport = ({ context, node, name }: IsCorpusExportOptions) => {
  const imported = resolveImport(context, node);
  return imported?.moduleId === CORPUS_MODULE && imported.imported === name;
};

type SqlTemplateTextOptions = {
  context: Parameters<typeof resolveImport>[0];
  node: ESTree.TaggedTemplateExpression;
};

const sqlTemplateText = ({ context, node }: SqlTemplateTextOptions) => {
  const chunks: string[] = [];
  for (let index = 0; index < node.quasi.quasis.length; index++) {
    chunks.push(node.quasi.quasis.at(index)?.value.cooked ?? "");
    const imported = resolveImport(context, node.quasi.expressions.at(index));
    if (
      imported !== null &&
      isSchemaModule(imported.moduleId) &&
      TABLES.has(imported.imported)
    ) {
      chunks.push(
        imported.imported === "caseLawDecisions"
          ? "case_law_decisions"
          : "case_law_decision_supplements",
      );
    } else {
      chunks.push(" ? ");
    }
  }
  return chunks.join("");
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          directTextWrite:
            "Persist case-law text, ASTs, raw payloads and storage pointers through a validated pipeline writer; only literal null clears and the canonical verified relocation/trim helpers may bypass it.",
        },
      },
      createOnce(context) {
        const safePayload = (node: unknown, depth = 0): boolean => {
          if (depth > MAX_AST_DEPTH) {
            return false;
          }
          if (
            isCorpusExport({
              context,
              node,
              name: "TRIMMED_CORPUS_PAYLOAD_COLUMNS",
            })
          ) {
            return true;
          }
          const value = resolvedValue({ context, node });
          if (value === null) {
            return false;
          }
          if (value.type === "Identifier" && value !== unwrapExpression(node)) {
            return safePayload(value, depth + 1);
          }
          if (value.type === "ConditionalExpression") {
            return (
              safePayload(value.consequent, depth + 1) &&
              safePayload(value.alternate, depth + 1)
            );
          }
          if (value.type === "CallExpression") {
            const imported = resolveImport(context, value.callee);
            if (
              imported?.moduleId === RAW_STORAGE_MODULE &&
              imported.imported === "confirmedRawRelocationColumns"
            ) {
              return true;
            }
          }
          if (
            value.type === "CallExpression" &&
            isCorpusExport({
              context,
              node: value.callee,
              name: "corpusMirrorColumns",
            })
          ) {
            const state = Array.isArray(value.arguments)
              ? resolvedValue({ context, node: value.arguments.at(0) })
              : null;
            const clear =
              state?.type === "ObjectExpression" &&
              Array.isArray(state.properties) &&
              state.properties.some(
                (property: unknown) =>
                  isAstNode(property) &&
                  getPropertyName(property.key) === "written" &&
                  isNull(property.value),
              );
            return (
              clear ||
              MIRROR_OWNERS.some((owner) =>
                filenameForContext(context).endsWith(owner),
              )
            );
          }
          if (value.type === "ArrayExpression") {
            return (
              Array.isArray(value.elements) &&
              value.elements.every((element) => safePayload(element, depth + 1))
            );
          }
          if (isEmptyObject(value)) {
            return true;
          }
          if (
            value.type !== "ObjectExpression" ||
            !Array.isArray(value.properties)
          ) {
            return false;
          }
          return value.properties.every((property: unknown) => {
            if (!isAstNode(property)) {
              return false;
            }
            if (property.type === "SpreadElement") {
              return safePayload(property.argument, depth + 1);
            }
            const name = getPropertyName(property.key);
            if (
              property.type !== "Property" ||
              name === null ||
              (property.computed === true && !isStringLiteral(property.key))
            ) {
              return false;
            }
            return (
              !PROTECTED_COLUMNS.has(name) ||
              isNull(property.value) ||
              (name === "fulltext" &&
                isStringLiteral(unwrapExpression(property.value)) &&
                unwrapExpression(property.value)?.value === "")
            );
          });
        };
        const inspectSql = (node: AstNode, source: string) => {
          if (sqlWritesPayload(source)) {
            context.report({ node, messageId: "directTextWrite" });
          }
        };
        return {
          before() {
            const filename = filenameForContext(context);
            if (
              filename.includes(
                ".oxlint-plugins/__fixtures__/no-direct-case-law-text-write.fixture",
              )
            ) {
              return true;
            }
            return (
              filename.includes("apps/api/") &&
              !isTestFile(filename) &&
              !filename.includes("apps/api/src/tests/") &&
              !PAYLOAD_OWNERS.some((owner) => filename.endsWith(owner)) &&
              !filename.endsWith(FIXTURE_SEED_OWNER)
            );
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type !== "MemberExpression" ||
              !Array.isArray(node.arguments)
            ) {
              return;
            }
            const method = memberPropertyName(callee);
            if (
              (method === "raw" || method === "execute") &&
              isStringLiteral(node.arguments.at(0))
            ) {
              const source = node.arguments.at(0);
              if (isStringLiteral(source)) {
                inspectSql(node, source.value);
              }
            }
            if (
              method === "select" &&
              ownsMutation({ context, node: callee.object })
            ) {
              context.report({ node, messageId: "directTextWrite" });
              return;
            }
            if (
              (method !== "set" &&
                method !== "values" &&
                method !== "onConflictDoUpdate") ||
              !ownsMutation({ context, node: callee.object })
            ) {
              return;
            }
            let payload: unknown = node.arguments.at(0);
            if (method === "onConflictDoUpdate") {
              const options = resolvedValue({ context, node: payload });
              if (
                options?.type === "ObjectExpression" &&
                Array.isArray(options.properties)
              ) {
                payload = options.properties.find(
                  (property: unknown) =>
                    isAstNode(property) &&
                    getPropertyName(property.key) === "set",
                )?.value;
              }
            }
            if (!safePayload(payload)) {
              context.report({ node, messageId: "directTextWrite" });
            }
          },
          TaggedTemplateExpression(node) {
            inspectSql(node, sqlTemplateText({ context, node }));
          },
        };
      },
    },
  },
});
