import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import { relations } from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import type { TransactionOf } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";

const databaseRelations = { ...relations, ...authRelationsPart };
const rootClient = new SQL({
  url: envBase.DATABASE_URL,
  max: envBase.DATABASE_ROOT_POOL_MAX,
});
const rlsClient = new SQL({
  url: envBase.DATABASE_URL,
  max: envBase.DATABASE_RLS_POOL_MAX,
});

/**
 * Primary database handle connecting as postgres (table owner).
 * This pool must never run scoped RLS transactions; it is reserved
 * for internal infrastructure such as workspace resolution and
 * Better Auth.
 */
export const rootDb = drizzle({
  client: rootClient,
  relations: databaseRelations,
});

const rawRlsDb = drizzle({
  client: rlsClient,
  relations: databaseRelations,
});

/**
 * Dedicated pool for scoped RLS transactions.
 *
 * Keeping this separate from `rootDb` makes root queries structurally
 * isolated from transaction-local role changes, even if a driver
 * ever mishandles connection cleanup after `set_config('role', ...)`.
 * The export only exposes `transaction`, so callers cannot use this
 * pool for non-scoped root-style reads by accident.
 */
export const rlsDb = markRlsDatabase({
  transaction: async <TResult>(
    fn: (tx: TransactionOf<typeof rawRlsDb>) => Promise<TResult>,
  ): Promise<TResult> => await rawRlsDb.transaction(fn),
});

type Database = typeof rootDb;
export type Transaction = TransactionOf<Database>;
