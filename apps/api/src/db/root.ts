import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  invoiceStatusEnum,
  propertyStatusEnum,
  relations,
  timeEntrySourceEnum,
  timeEntryStatusEnum,
} from "@/api/db/schema";
import type { TransactionOf } from "@/api/db/scoped";
import { env } from "@/api/env";

/**
 * Primary database handle connecting as postgres (table owner).
 * RLS is enforced per-transaction via `SET LOCAL ROLE stella`.
 *
 * All handler queries MUST go through `ScopedDb`.
 * Direct `db` usage is reserved for internal infrastructure
 * (workspace resolution in authMacro, better-auth).
 */
export const db = drizzle(env.DATABASE_URL, {
  relations: { ...relations, ...authRelationsPart },
  schema: {
    propertyStatusEnum,
    timeEntryStatusEnum,
    timeEntrySourceEnum,
    invoiceStatusEnum,
  },
});

type Database = typeof db;
export type Transaction = TransactionOf<Database>;
