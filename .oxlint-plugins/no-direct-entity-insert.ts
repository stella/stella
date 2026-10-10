import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isTestFile,
  resolveImport,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-direct-entity-insert";
const TABLE_NAME = "entities";
const OWNER_PATHS = [
  "apps/api/src/lib/entities/sibling-name-insert.ts",
  "apps/api/src/lib/entity-versions/insert-entity-batch.ts",
] as const;
// These independent creation flows retain their existing title semantics.
// Extending sibling naming to them also needs their existing lock contracts.
const EXISTING_WRITERS = [
  {
    path: "apps/api/src/handlers/entities/create.ts",
    reason: "empty folders and documents",
  },
  {
    path: "apps/api/src/handlers/entities/clip.ts",
    reason: "web clips with page titles",
  },
  {
    path: "apps/api/src/lib/tasks/create-task-entity.ts",
    reason: "tasks with repeatable titles",
  },
  {
    path: "apps/api/src/lib/infosoud/agenda-import.ts",
    reason: "idempotent external agenda identities",
  },
] as const;
const FIXTURE_PATH =
  ".oxlint-plugins/__fixtures__/no-direct-entity-insert.fixture.ts";
const SCHEMA_MODULES = new Set([
  "apps/api/src/db/schema",
  "apps/api/src/db/schema/entities",
]);

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directWrite:
            "Insert entities through sibling-name-insert.ts or insert-entity-batch.ts, whose name parameters require a resolved sibling name.",
        },
        schema: [],
      },
      createOnce(context) {
        const isEntitiesTable = (node: unknown): boolean => {
          const table = resolveImport(context, node);
          return (
            table?.imported === TABLE_NAME && SCHEMA_MODULES.has(table.moduleId)
          );
        };

        return {
          before() {
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE_PATH)) {
              return true;
            }
            return (
              filename.includes("apps/api/src/") &&
              !OWNER_PATHS.some((ownerPath) => filename.endsWith(ownerPath)) &&
              !EXISTING_WRITERS.some(({ path }) => filename.endsWith(path)) &&
              !isTestFile(filename)
            );
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type !== "MemberExpression" ||
              getPropertyName(callee.property) !== "insert" ||
              !Array.isArray(node.arguments) ||
              !isEntitiesTable(node.arguments.at(0))
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
