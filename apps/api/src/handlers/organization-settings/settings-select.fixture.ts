import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { PgTable, SelectedFields } from "drizzle-orm/pg-core";

/** Keep real query metadata and locking SQL while replacing database execution. */
export const settingsSelectFixture = (
  read: (statement: SQL) => Record<string, unknown>[],
) => {
  const database = drizzle.mock();
  return (fields: SelectedFields) => ({
    from: (table: PgTable) => {
      const query = database.select(fields).from(table);
      return Object.assign(query, {
        execute: async () => Promise.resolve(read(query.getSQL())),
      });
    },
  });
};
