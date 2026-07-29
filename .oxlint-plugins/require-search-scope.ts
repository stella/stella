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

const PRIVATE_SEARCH_PROJECTIONS = {
  search_documents: [
    {
      importedName: "workspaceAccessSql",
      module: "@/api/lib/search/contact-workspace-access-sql",
    },
  ],
  workspace_search_documents: [
    {
      importedName: "workspaceAccessSql",
      module: "@/api/lib/search/contact-workspace-access-sql",
    },
  ],
  contact_search_documents: [
    {
      importedName: "contactWorkspaceAccessSql",
      module: "@/api/lib/search/contact-workspace-access-sql",
    },
  ],
  chat_thread_search_documents: [
    {
      importedName: "chatThreadScopeSql",
      module: "@/api/lib/search/chat-thread-scope-sql",
    },
  ],
} as const;

type ApprovedScopeImport =
  (typeof PRIVATE_SEARCH_PROJECTIONS)[keyof typeof PRIVATE_SEARCH_PROJECTIONS][number];

const templateText = (node: Record<string, unknown>): string => {
  const quasi = node.quasi;
  if (!isAstNode(quasi) || !Array.isArray(quasi.quasis)) {
    return "";
  }

  return quasi.quasis
    .flatMap((element) => {
      if (!isAstNode(element)) {
        return [];
      }
      const value = element.value;
      if (typeof value !== "object" || value === null || !("raw" in value)) {
        return [];
      }
      const raw = value.raw;
      return typeof raw === "string" ? [raw] : [];
    })
    .join(" ");
};

const templateExpressions = (node: Record<string, unknown>): unknown[] => {
  const quasi = node.quasi;
  if (isAstNode(quasi) && Array.isArray(quasi.expressions)) {
    return quasi.expressions;
  }
  return [];
};

export default {
  meta: { name: "require-search-scope" },
  rules: {
    "require-search-scope": {
      meta: {
        type: "problem",
        messages: {
          missingScope:
            "Raw SELECT from private search projection `{{table}}` must " +
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

        const isApprovedScopeImport = (
          identifier: AstNode & { name: string },
          approvedImports: readonly ApprovedScopeImport[],
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
          approvedImports: readonly ApprovedScopeImport[],
        ): boolean => {
          const unwrapped = unwrapExpression(expression);
          return (
            isAstNode(unwrapped) &&
            unwrapped.type === "CallExpression" &&
            isIdentifier(unwrapped.callee) &&
            isApprovedScopeImport(unwrapped.callee, approvedImports)
          );
        };

        const isApprovedScopeFragment = (
          expression: unknown,
          approvedImports: readonly ApprovedScopeImport[],
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

        return {
          TaggedTemplateExpression(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            const text = templateText(node);
            if (!/\bselect\b/iu.test(text)) {
              return;
            }

            const expressions = templateExpressions(node);
            for (const [table, approvedImports] of Object.entries(
              PRIVATE_SEARCH_PROJECTIONS,
            )) {
              if (!new RegExp(`\\b${table}\\b`, "u").test(text)) {
                continue;
              }
              if (
                expressions.some((expression) =>
                  isApprovedScopeFragment(expression, approvedImports),
                )
              ) {
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
