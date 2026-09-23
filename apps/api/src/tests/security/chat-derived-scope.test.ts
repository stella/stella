import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";

import * as schema from "@/api/db/schema";

/**
 * Rows that reference a chat thread restate what the thread put in front of
 * the model, so each must be held to the thread's data scope: either its RLS
 * joins `chat_threads` (and so applies the thread's own scope check), or it
 * carries its own `source_data_workspace_ids` enforced by its policies.
 * A new table referencing `chat_threads` has to take one of those shapes.
 */

const SOURCE_SCOPE_COLUMN = "source_data_workspace_ids";

/**
 * Tables that reference a thread but hold no content derived from it: they
 * point a file or template at its latest thread, and following the pointer
 * reads the thread under the thread's own scope.
 */
const POINTER_ONLY_TABLES: ReadonlyMap<string, string> = new Map([
  ["file_chat_threads", "maps a file to its latest thread id"],
  ["template_chat_threads", "maps a template to its latest thread id"],
]);

const renderPolicies = (table: PgTable): string => {
  const dialect = new PgDialect();
  return getTableConfig(table)
    .policies.flatMap((policy) => [policy.using, policy.withCheck])
    .filter((clause) => clause !== undefined)
    .map((clause) => dialect.sqlToQuery(clause).sql)
    .join("\n");
};

const isPgTable = (value: unknown): value is PgTable => is(value, PgTable);

// Annotated as `unknown` so the traversal does not infer a union of every
// table type.
const schemaExports: Record<string, unknown> = { ...schema };

const tablesReferencingChatThreads = (): PgTable[] =>
  Object.values(schemaExports)
    .filter(isPgTable)
    .filter(
      (table) =>
        table !== schema.chatThreads &&
        getTableConfig(table).foreignKeys.some(
          (foreignKey) =>
            foreignKey.reference().foreignTable === schema.chatThreads,
        ),
    );

describe("chat-derived rows carry the thread's data scope", () => {
  test("the schema has tables referencing chat threads", () => {
    expect(tablesReferencingChatThreads().length).toBeGreaterThan(0);
  });

  test("each is scoped by a thread join or its own source scope", () => {
    const unscoped = tablesReferencingChatThreads()
      .filter((table) => {
        const config = getTableConfig(table);
        const policies = renderPolicies(table);
        const joinsThread = /\bchat_threads\b/u.test(policies);
        const ownSourceScope =
          config.columns.some(
            (column) => column.name === SOURCE_SCOPE_COLUMN,
          ) && policies.includes(SOURCE_SCOPE_COLUMN);
        return (
          !joinsThread &&
          !ownSourceScope &&
          !POINTER_ONLY_TABLES.has(config.name)
        );
      })
      .map((table) => getTableConfig(table).name);

    expect(unscoped).toEqual([]);
  });

  test("pointer-only exemptions name tables that still reference threads", () => {
    const referencing = new Set(
      tablesReferencingChatThreads().map((table) => getTableConfig(table).name),
    );

    expect(
      [...POINTER_ONLY_TABLES.keys()].filter((name) => !referencing.has(name)),
    ).toEqual([]);
  });
});
