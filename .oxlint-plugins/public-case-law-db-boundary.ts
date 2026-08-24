import { eslintCompatPlugin } from "@oxlint/plugins";

import { PUBLIC_CASE_LAW_SCHEMA_IMPORTS } from "../apps/api/src/lib/public-law-relations.ts";
import { getImportedName, getPropertyName, isIdentifier } from "./utils.ts";

type AstNode = Record<string, unknown> & { type: string };

const PRIVATE_SQL_TOKEN_RE =
  /\b(?:workspace|workspaces|organization|organizations|entity|entities|field|fields|file|files|chat|user|session|account|matter|matters|task|tasks|contact|contacts)\b/iu;

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const PUBLIC_CASE_LAW_SCHEMA_IMPORT_SET = new Set(
  PUBLIC_CASE_LAW_SCHEMA_IMPORTS,
);

const PUBLIC_CASE_LAW_QUERY_RELATIONS = new Set(["caseLawDecisions"]);

const getTxQueryObject = (node: unknown): AstNode | null => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return null;
  }
  const object = node.object;
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

const rawTemplateText = (node): string | null => {
  if (node.type !== "TemplateElement") {
    return null;
  }
  const value = node.value;
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
            "Public case-law data files may only import the explicit public case-law table allowlist from '@/api/db/schema'.",
          privateTxQuery:
            "Public case-law data files may only use the explicit public tx.query relation allowlist.",
          privateSqlText:
            "Public case-law SQL must not mention private workspace, user, organization, matter, file, chat, task, or contact tables.",
        },
      },
      createOnce(context) {
        return {
          ImportDeclaration(node) {
            if (node.source.value !== "@/api/db/schema") {
              return;
            }
            const specifiers = node.specifiers;
            for (const specifier of specifiers) {
              const imported = getImportedName(specifier);
              if (
                imported === null ||
                !PUBLIC_CASE_LAW_SCHEMA_IMPORT_SET.has(imported)
              ) {
                context.report({
                  node: specifier,
                  messageId: "privateCaseLawImport",
                });
              }
            }
          },
          MemberExpression(node) {
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
            if (
              typeof node.value === "string" &&
              hasPrivateSqlText(node.value)
            ) {
              context.report({ node, messageId: "privateSqlText" });
            }
          },
          TemplateElement(node) {
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
