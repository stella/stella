// A legislation body and its version metadata describe one fetched revision.
// Partial owners may only write their explicit, unrelated column sets. Raw SQL
// and mutable aliases are outside this syntax guard's detection boundary.
import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isTestFile,
  memberPropertyName,
  resolveImport,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-direct-legislation-revision-write";
const OWNER_PATH = "apps/api/src/handlers/legislation/ingestion.ts";
const FIXTURE_FILE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-direct-legislation-revision-write.fixture.ts";
export const LEGISLATION_PARTIAL_WRITERS = {
  "apps/api/src/handlers/legislation/withdrawal.ts": [
    "windowDisposition",
    "windowDispositionBasis",
  ],
  "apps/api/src/lib/scheduler/tasks/legislation-expression-id-backfill.ts": [
    "publisherExpressionId",
    "updatedAt",
  ],
  "apps/api/src/lib/legal-search/corpus-index-projection-bootstrap.ts": [
    "projectionEpoch",
  ],
  "apps/api/src/lib/legal-search/corpus-index-projection-desired-state.ts": [
    "projectionEpoch",
  ],
} as const;
const MUTATION_METHODS = new Set(["insert", "update", "delete"]);

const hasOnlyAllowedColumns = (
  update: AstNode,
  allowed: readonly string[],
): boolean => {
  const member = update.parent;
  if (
    !isAstNode(member) ||
    member.type !== "MemberExpression" ||
    memberPropertyName(member) !== "set"
  ) {
    return false;
  }
  const call = member.parent;
  if (!isAstNode(call) || call.type !== "CallExpression") {
    return false;
  }
  const payload = Array.isArray(call.arguments)
    ? unwrapExpression(call.arguments.at(0))
    : null;
  return (
    payload?.type === "ObjectExpression" &&
    Array.isArray(payload.properties) &&
    payload.properties.every(
      (property: unknown) =>
        isAstNode(property) &&
        property.type === "Property" &&
        property.computed !== true &&
        property.kind === "init" &&
        allowed.includes(getPropertyName(property.key) ?? ""),
    )
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directWrite:
            "Write legislation body and version metadata through handlers/legislation/ingestion.ts. Partial owners may update only their declared unrelated columns with an explicit object literal.",
        },
        schema: [],
      },
      createOnce(context) {
        let allowedColumns: readonly string[] = [];
        return {
          before() {
            const filename = filenameForContext(context);
            allowedColumns =
              Object.entries(LEGISLATION_PARTIAL_WRITERS).find(([owner]) =>
                filename.endsWith(owner),
              )?.[1] ?? [];
            return (
              filename.endsWith(FIXTURE_FILE_SUFFIX) ||
              (filename.includes("apps/api/src/") &&
                !filename.endsWith(OWNER_PATH) &&
                !isTestFile(filename))
            );
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (callee?.type !== "MemberExpression") {
              return;
            }
            const method = memberPropertyName(callee);
            if (method === null || !MUTATION_METHODS.has(method)) {
              return;
            }
            const table = resolveImport(context, node.arguments.at(0));
            if (
              table?.imported !== "legislationDocuments" ||
              ![
                "apps/api/src/db/schema",
                "apps/api/src/db/schema/legislation",
              ].includes(table.moduleId)
            ) {
              return;
            }
            if (
              method === "update" &&
              allowedColumns.length > 0 &&
              hasOnlyAllowedColumns(node, allowedColumns)
            ) {
              return;
            }
            context.report({ node, messageId: "directWrite" });
          },
        };
      },
    },
  },
});
