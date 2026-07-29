// Require an explicit authorization-scope fragment on raw SQL reads from
// private search projections. Global search uses the RLS-bypassing root
// connection, so a newly added source branch without one of these fragments
// could leak result titles, snippets, counts, or facets across workspaces.
//
// This rule is intentionally syntactic. It proves that a query composes one
// of the small approved, import-verified scope builders; compiled-SQL and
// adversarial integration tests prove the predicates those builders emit.

import {
  getImportedName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

type ScopeDefinition = {
  node: unknown;
  parent?: unknown;
  type: string;
};

type ScopeVariable = {
  defs: ScopeDefinition[];
};

type Scope = {
  set: Map<string, ScopeVariable>;
  upper: Scope | null;
};

type RuleContext = {
  report: (descriptor: {
    data: { table: string };
    messageId: "missingScope";
    node: unknown;
  }) => void;
  sourceCode: {
    getScope: (node: unknown) => Scope;
  };
};

type ApprovedImport = {
  importedName: string;
  module: string;
};

const PRIVATE_SEARCH_PROJECTIONS = {
  search_documents: {
    expectedAlias: "sd",
    scopeImports: [
      {
        importedName: "searchDocumentsAccessSql",
        module: "@/api/lib/search/contact-workspace-access-sql",
      },
    ],
    tableImports: [
      { importedName: "searchDocuments", module: "@/api/db/schema" },
      {
        importedName: "searchDocuments",
        module: "@/api/db/schema/templates",
      },
    ],
  },
  workspace_search_documents: {
    expectedAlias: "wsd",
    scopeImports: [
      {
        importedName: "workspaceSearchDocumentsAccessSql",
        module: "@/api/lib/search/contact-workspace-access-sql",
      },
    ],
    tableImports: [
      { importedName: "workspaceSearchDocuments", module: "@/api/db/schema" },
      {
        importedName: "workspaceSearchDocuments",
        module: "@/api/db/schema/templates",
      },
    ],
  },
  contact_search_documents: {
    expectedAlias: "csd",
    scopeImports: [
      {
        importedName: "contactWorkspaceAccessSql",
        module: "@/api/lib/search/contact-workspace-access-sql",
      },
    ],
    tableImports: [
      { importedName: "contactSearchDocuments", module: "@/api/db/schema" },
      {
        importedName: "contactSearchDocuments",
        module: "@/api/db/schema/templates",
      },
    ],
  },
  chat_thread_search_documents: {
    expectedAlias: "cst",
    scopeImports: [
      {
        importedName: "chatThreadScopeSql",
        module: "@/api/lib/search/chat-thread-scope-sql",
      },
    ],
    tableImports: [
      { importedName: "chatThreadSearchDocuments", module: "@/api/db/schema" },
      {
        importedName: "chatThreadSearchDocuments",
        module: "@/api/db/schema/chat",
      },
    ],
  },
} as const satisfies Record<
  string,
  {
    expectedAlias: string;
    scopeImports: readonly ApprovedImport[];
    tableImports: readonly ApprovedImport[];
  }
>;

const templateQuasiTexts = (node: Record<string, unknown>): string[] => {
  const quasi = node.quasi;
  if (!isAstNode(quasi) || !Array.isArray(quasi.quasis)) {
    return [];
  }

  return quasi.quasis.map((element) => {
    if (!isAstNode(element)) {
      return "";
    }
    const value = element.value;
    if (typeof value !== "object" || value === null || !("raw" in value)) {
      return "";
    }
    const raw = value.raw;
    return typeof raw === "string" ? raw : "";
  });
};

const templateExpressions = (node: Record<string, unknown>): unknown[] => {
  const quasi = node.quasi;
  if (isAstNode(quasi) && Array.isArray(quasi.expressions)) {
    return quasi.expressions;
  }
  return [];
};

type SqlTemplateToken =
  | { type: "expression"; value: unknown }
  | { type: "text"; value: string };

const SQL_ALIAS_STOP_WORDS = new Set([
  "cross",
  "except",
  "full",
  "group",
  "inner",
  "intersect",
  "join",
  "left",
  "limit",
  "offset",
  "on",
  "order",
  "outer",
  "returning",
  "right",
  "set",
  "union",
  "values",
  "where",
  "window",
]);

const normalizeProjectionAlias = (alias: string | undefined): string | null => {
  if (!alias) {
    return null;
  }
  const normalized = alias.toLowerCase();
  return SQL_ALIAS_STOP_WORDS.has(normalized) ? null : normalized;
};

const projectionReadAliases = (
  text: string,
  table: string,
): (string | null)[] => {
  const matches = text.matchAll(
    new RegExp(
      `\\b${table}\\b(?:\\s+(?:as\\s+)?([A-Za-z_][A-Za-z0-9_]*))?`,
      "giu",
    ),
  );
  return [...matches].map((match) => normalizeProjectionAlias(match.at(1)));
};

const leadingProjectionAlias = (text: string): string | null => {
  const match = text.match(/^\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/iu);
  return normalizeProjectionAlias(match?.at(1));
};

type SqlLexState =
  | { type: "block-comment"; depth: number }
  | { type: "dollar-quote"; delimiter: string }
  | { type: "double-quote" }
  | { type: "line-comment" }
  | { type: "normal" }
  | { type: "single-quote" };

const DOLLAR_QUOTE_START = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;

const sqlLexStateAfter = (
  text: string,
  initialState: SqlLexState,
): SqlLexState => {
  let state = initialState;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    switch (state.type) {
      case "normal":
        if (char === "-" && next === "-") {
          state = { type: "line-comment" };
          index += 1;
        } else if (char === "/" && next === "*") {
          state = { type: "block-comment", depth: 1 };
          index += 1;
        } else if (char === "'") {
          state = { type: "single-quote" };
        } else if (char === '"') {
          state = { type: "double-quote" };
        } else if (char === "$") {
          const delimiter = text.slice(index).match(DOLLAR_QUOTE_START)?.at(0);
          if (delimiter) {
            state = { type: "dollar-quote", delimiter };
            index += delimiter.length - 1;
          }
        }
        break;
      case "line-comment":
        if (char === "\n" || char === "\r") {
          state = { type: "normal" };
        }
        break;
      case "block-comment":
        if (char === "/" && next === "*") {
          state = { type: "block-comment", depth: state.depth + 1 };
          index += 1;
        } else if (char === "*" && next === "/") {
          state =
            state.depth === 1
              ? { type: "normal" }
              : { type: "block-comment", depth: state.depth - 1 };
          index += 1;
        }
        break;
      case "single-quote":
        if (char === "\\" && next !== undefined) {
          index += 1;
        } else if (char === "'" && next === "'") {
          index += 1;
        } else if (char === "'") {
          state = { type: "normal" };
        }
        break;
      case "double-quote":
        if (char === "\\" && next !== undefined) {
          index += 1;
        } else if (char === '"' && next === '"') {
          index += 1;
        } else if (char === '"') {
          state = { type: "normal" };
        }
        break;
      case "dollar-quote":
        if (text.startsWith(state.delimiter, index)) {
          index += state.delimiter.length - 1;
          state = { type: "normal" };
        }
        break;
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  }
  return state;
};

export default {
  meta: { name: "require-search-scope" },
  rules: {
    "require-search-scope": {
      meta: {
        type: "problem",
        messages: {
          missingScope:
            "Raw read from private search projection `{{table}}` must " +
            "compose an approved workspace/contact/chat authorization scope " +
            "fragment. Add the appropriate scope helper; do not post-filter.",
        },
      },
      create(context: RuleContext) {
        const resolveVariable = (
          identifier: AstNode & { name: string },
        ): ScopeVariable | null => {
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope) {
            const variable = scope.set.get(identifier.name);
            if (variable) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const isApprovedImport = (
          identifier: AstNode & { name: string },
          approvedImports: readonly ApprovedImport[],
        ): boolean => {
          const variable = resolveVariable(identifier);
          return (
            variable?.defs.some((definition) => {
              if (
                definition.type !== "ImportBinding" ||
                !isAstNode(definition.node) ||
                !isAstNode(definition.parent) ||
                definition.parent.type !== "ImportDeclaration" ||
                !isStringLiteral(definition.parent.source)
              ) {
                return false;
              }
              const importedName = getImportedName(definition.node);
              const source = definition.parent.source;
              return approvedImports.some(
                (approved) =>
                  approved.importedName === importedName &&
                  approved.module === source.value,
              );
            }) === true
          );
        };

        const isApprovedScopeCall = (
          expression: unknown,
          approvedImports: readonly ApprovedImport[],
        ): boolean => {
          const unwrapped = unwrapExpression(expression);
          return (
            isAstNode(unwrapped) &&
            unwrapped.type === "CallExpression" &&
            isIdentifier(unwrapped.callee) &&
            isApprovedImport(unwrapped.callee, approvedImports)
          );
        };

        const isApprovedScopeFragment = (
          expression: unknown,
          approvedImports: readonly ApprovedImport[],
        ): boolean => {
          const unwrapped = unwrapExpression(expression);
          if (isApprovedScopeCall(unwrapped, approvedImports)) {
            return true;
          }
          if (!isIdentifier(unwrapped)) {
            return false;
          }
          const variable = resolveVariable(unwrapped);
          return (
            variable?.defs.some((definition) => {
              if (
                definition.type !== "Variable" ||
                !isAstNode(definition.node) ||
                definition.node.type !== "VariableDeclarator" ||
                !isAstNode(definition.parent) ||
                definition.parent.type !== "VariableDeclaration" ||
                definition.parent.kind !== "const"
              ) {
                return false;
              }
              return isApprovedScopeCall(definition.node.init, approvedImports);
            }) === true
          );
        };

        const isPrivateProjectionInterpolation = (
          expression: unknown,
          tableImports: readonly ApprovedImport[],
        ): boolean => {
          const unwrapped = unwrapExpression(expression);
          return (
            isIdentifier(unwrapped) && isApprovedImport(unwrapped, tableImports)
          );
        };

        const resolveConstSqlTemplate = (
          expression: unknown,
        ): AstNode | null => {
          const unwrapped = unwrapExpression(expression);
          if (
            isAstNode(unwrapped) &&
            unwrapped.type === "TaggedTemplateExpression"
          ) {
            return unwrapped;
          }
          if (!isIdentifier(unwrapped)) {
            return null;
          }
          const variable = resolveVariable(unwrapped);
          for (const definition of variable?.defs ?? []) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              continue;
            }
            const init = unwrapExpression(definition.node.init);
            if (isAstNode(init) && init.type === "TaggedTemplateExpression") {
              return init;
            }
          }
          return null;
        };

        const flattenSqlTemplate = (
          node: AstNode,
          ancestors: ReadonlySet<unknown> = new Set(),
        ): SqlTemplateToken[] => {
          if (ancestors.has(node)) {
            return [];
          }
          const nextAncestors = new Set(ancestors);
          nextAncestors.add(node);
          const quasiTexts = templateQuasiTexts(node);
          const expressions = templateExpressions(node);
          const tokens: SqlTemplateToken[] = [];
          for (const [index, quasiText] of quasiTexts.entries()) {
            tokens.push({ type: "text", value: quasiText });
            const expression = expressions.at(index);
            if (expression === undefined) {
              continue;
            }
            const nestedTemplate = resolveConstSqlTemplate(expression);
            if (nestedTemplate) {
              tokens.push(...flattenSqlTemplate(nestedTemplate, nextAncestors));
              continue;
            }
            tokens.push({ type: "expression", value: expression });
          }
          return tokens;
        };

        return {
          TaggedTemplateExpression(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            const tokens = flattenSqlTemplate(node);
            const text = tokens
              .filter(
                (token): token is Extract<SqlTemplateToken, { type: "text" }> =>
                  token.type === "text",
              )
              .map((token) => token.value)
              .join(" ");
            if (!/\b(?:select|table)\b/iu.test(text)) {
              return;
            }

            for (const [table, projection] of Object.entries(
              PRIVATE_SEARCH_PROJECTIONS,
            )) {
              let unscopedReadCount = 0;
              let scopeEligibleReadCount = 0;
              let sqlLexState: SqlLexState = { type: "normal" };
              for (const [index, token] of tokens.entries()) {
                if (token.type === "text") {
                  const aliases = projectionReadAliases(token.value, table);
                  unscopedReadCount += aliases.length;
                  scopeEligibleReadCount += aliases.filter(
                    (alias) => alias === projection.expectedAlias,
                  ).length;
                  sqlLexState = sqlLexStateAfter(token.value, sqlLexState);
                  continue;
                }
                if (
                  sqlLexState.type === "normal" &&
                  isPrivateProjectionInterpolation(
                    token.value,
                    projection.tableImports,
                  )
                ) {
                  unscopedReadCount += 1;
                  const nextToken = tokens.at(index + 1);
                  if (
                    nextToken?.type === "text" &&
                    leadingProjectionAlias(nextToken.value) ===
                      projection.expectedAlias
                  ) {
                    scopeEligibleReadCount += 1;
                  }
                }
                if (
                  unscopedReadCount > 0 &&
                  scopeEligibleReadCount > 0 &&
                  sqlLexState.type === "normal" &&
                  isApprovedScopeFragment(token.value, projection.scopeImports)
                ) {
                  unscopedReadCount -= 1;
                  scopeEligibleReadCount -= 1;
                }
              }
              if (unscopedReadCount === 0) {
                continue;
              }
              context.report({
                node,
                messageId: "missingScope",
                data: { table },
              });
            }
          },
        };
      },
    },
  },
};
