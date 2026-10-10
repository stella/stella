import { getColumns, getTableName, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/** Historical policy fixtures use current models without replacing their policies. */
export const addEntityFeatureFixtureColumns = async (
  db: { execute: (query: SQL) => PromiseLike<unknown> },
  tables: readonly PgTable[],
): Promise<void> => {
  const statements = tables.flatMap((table) =>
    Object.values(getColumns(table))
      .filter((column) => column.name.startsWith("entity_feature_"))
      .map((column) =>
        sql`ALTER TABLE ${sql.identifier(getTableName(table))}
        ADD COLUMN ${sql.identifier(column.name)} ${sql.raw(column.getSQLType())}
        DEFAULT ${column.default} ${sql.raw(column.notNull ? "NOT NULL" : "")}`.inlineParams(),
      ),
  );
  await db.execute(sql.join(statements, sql`; `));
};
