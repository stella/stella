import {
  getImportedName,
  getPropertyName,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

type AstNode = Record<string, unknown> & { type: string };

type RuleContext = {
  report: (descriptor: {
    node: unknown;
    messageId: "privateCaseLawImport" | "privateTxQuery" | "privateSqlText";
  }) => void;
};

const PRIVATE_SQL_TOKEN_RE =
  /\b(?:workspace|workspaces|organization|organizations|entity|entities|field|fields|file|files|chat|user|session|account|matter|matters|task|tasks|contact|contacts)\b/iu;

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof (value as { type: unknown }).type === "string";

const isCaseLawName = (name: string): boolean => name.startsWith("caseLaw");

const isTxQueryMember = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return false;
  }
  const object = node.object;
  if (!isAstNode(object) || object.type !== "MemberExpression") {
    return false;
  }
  return (
    object.computed === false &&
    isIdentifier(object.object, "tx") &&
    isIdentifier(object.property, "query")
  );
};

const rawTemplateText = (node: AstNode): string | null => {
  if (node.type !== "TemplateElement") {
    return null;
  }
  const value = node.value;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = (value as { raw?: unknown }).raw;
  return typeof raw === "string" ? raw : null;
};

const hasPrivateSqlText = (text: string): boolean =>
  PRIVATE_SQL_TOKEN_RE.test(text);

export default {
  meta: { name: "public-case-law-db-boundary" },
  rules: {
    "public-case-law-db-boundary": {
      meta: {
        type: "problem",
        messages: {
          privateCaseLawImport:
            "Public case-law data files may only import caseLaw* tables from '@/api/db/schema'.",
          privateTxQuery:
            "Public case-law data files may only query tx.query.caseLaw* relations.",
          privateSqlText:
            "Public case-law SQL must not mention private workspace, user, organization, matter, file, chat, task, or contact tables.",
        },
      },
      create(context: RuleContext) {
        return {
          ImportDeclaration(node: unknown) {
            if (!isAstNode(node) || node.source !== "@/api/db/schema") {
              return;
            }
            const specifiers = node.specifiers;
            if (!Array.isArray(specifiers)) {
              return;
            }
            for (const specifier of specifiers) {
              const imported = getImportedName(specifier);
              if (imported !== null && !isCaseLawName(imported)) {
                context.report({
                  node: specifier,
                  messageId: "privateCaseLawImport",
                });
              }
            }
          },
          MemberExpression(node: unknown) {
            if (!isTxQueryMember(node) || !isAstNode(node)) {
              return;
            }
            const propertyName = getPropertyName(node.property);
            if (propertyName !== null && !isCaseLawName(propertyName)) {
              context.report({ node, messageId: "privateTxQuery" });
            }
          },
          Literal(node: unknown) {
            if (isStringLiteral(node) && hasPrivateSqlText(node.value)) {
              context.report({ node, messageId: "privateSqlText" });
            }
          },
          TemplateElement(node: unknown) {
            if (!isAstNode(node)) {
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
};
