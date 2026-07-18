import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { agentAuthRelationsPart } from "@/api/db/agent-auth-schema";
import { authRelationsPart } from "@/api/db/auth-schema";
import { relations } from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import type { TransactionOf } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { queryCountLogger } from "@/api/lib/db-query-counter";

const databaseRelations = {
  ...relations,
  ...authRelationsPart,
  ...agentAuthRelationsPart,
};

// Per-request query counter feeds the `x-db-queries` response header for the
// N+1 e2e guard. Local/CI only: deployed environments pass no logger at all,
// keeping zero per-query overhead on the hot path. The logger itself is a
// no-op unless a request has activated a counter store, so background jobs
// and boot-time queries are unaffected even when it is wired in. Must match
// the header gate in index.ts.
const queryLogger = envBase.isDev ? queryCountLogger : undefined;

// Optional pool recycling. Defaults remain disabled until the Bun SQL runtime
// retires only idle connections; values are seconds and apply to both pools.
const poolRecycling = {
  maxLifetime: envBase.DATABASE_POOL_MAX_LIFETIME_S,
  idleTimeout: envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
} as const;

const rootClient = new SQL({
  url: envBase.DATABASE_URL,
  max: envBase.DATABASE_ROOT_POOL_MAX,
  ...poolRecycling,
});
const rlsClient = new SQL({
  url: envBase.DATABASE_URL,
  max: envBase.DATABASE_RLS_POOL_MAX,
  ...poolRecycling,
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
  logger: queryLogger,
});

const rawRlsDb = drizzle({
  client: rlsClient,
  relations: databaseRelations,
  logger: queryLogger,
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
