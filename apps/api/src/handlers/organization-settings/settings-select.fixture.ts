import type { SQL } from "drizzle-orm";
import type { PgTable, SelectedFields } from "drizzle-orm/pg-core";

import { createMockDatabase } from "@/api/db/sql-client";

/** Keep real query metadata and locking SQL while replacing database execution. */
export const settingsSelectFixture = (
  read: (statement: SQL) => Record<string, unknown>[],
) => {
  const database = createMockDatabase();
  return (fields: SelectedFields) => ({
    from: (table: PgTable) => {
      const query = database.select(fields).from(table);
      return Object.assign(query, {
        execute: async () => await Promise.resolve(read(query.getSQL())),
      });
    },
  });
};
