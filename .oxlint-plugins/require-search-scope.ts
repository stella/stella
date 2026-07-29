// Require an explicit authorization-scope fragment on raw SQL reads from
// private search projections. Global search uses the RLS-bypassing root
// connection, so a newly added source branch without one of these fragments
// could leak result titles, snippets, counts, or facets across workspaces.
//
// This rule is intentionally syntactic. It proves that a query composes one
// of the small approved scope builders (or a branded single-workspace scope);
// compiled-SQL and adversarial integration tests prove the predicates that
// those builders emit.

type AstNode = Record<string, unknown> & { type: string };

type RuleContext = {
  report: (descriptor: {
    data: { table: string };
    messageId: "missingScope";
    node: unknown;
  }) => void;
};

const PRIVATE_SEARCH_PROJECTIONS = {
  search_documents: new Set([
    "entityWorkspaceFilter",
    "entityWorkspaceFacetFilter",
    "singleWorkspaceFilter",
    "workspaceAccessFilter",
    "workspaceAccessSql",
  ]),
  workspace_search_documents: new Set([
    "matterWorkspaceFilter",
    "matterWorkspaceFacetFilter",
    "workspaceAccessSql",
  ]),
  contact_search_documents: new Set([
    "contactWorkspaceFilter",
    "contactWorkspaceAccessSql",
  ]),
  chat_thread_search_documents: new Set(["chatScope", "chatThreadScopeSql"]),
} as const;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const templateText = (node: AstNode): string => {
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

const directExpressionName = (expression: unknown): string | null => {
  if (!isAstNode(expression)) {
    return null;
  }
  if (expression.type === "Identifier" && typeof expression.name === "string") {
    return expression.name;
  }
  if (expression.type !== "CallExpression") {
    return null;
  }
  const callee = expression.callee;
  return isAstNode(callee) &&
    callee.type === "Identifier" &&
    typeof callee.name === "string"
    ? callee.name
    : null;
};

const templateDirectExpressionNames = (node: AstNode): Set<string> => {
  const quasi = node.quasi;
  const names = new Set<string>();
  if (isAstNode(quasi) && Array.isArray(quasi.expressions)) {
    for (const expression of quasi.expressions) {
      const name = directExpressionName(expression);
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
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
        return {
          TaggedTemplateExpression(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            const text = templateText(node);
            if (!/\bselect\b/iu.test(text)) {
              return;
            }

            const names = templateDirectExpressionNames(node);
            for (const [table, approvedNames] of Object.entries(
              PRIVATE_SEARCH_PROJECTIONS,
            )) {
              if (!new RegExp(`\\b${table}\\b`, "u").test(text)) {
                continue;
              }
              if ([...approvedNames].some((name) => names.has(name))) {
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
