import type { databaseRelations } from "@/api/db/database-relations";
import type { TransactionOf } from "@/api/db/scoped";
import type { createDatabase } from "@/api/db/sql-client";

export type RootDatabase = ReturnType<
  typeof createDatabase<typeof databaseRelations>
>;
export type Transaction = TransactionOf<RootDatabase>;
