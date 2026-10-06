import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";
import { markRlsDatabase } from "@/api/db/scoped";
import type { TransactionOf } from "@/api/db/scoped";
import { sharedPoolConnectionSettings } from "@/api/db/shared-pool-connection-settings";
import { envBase } from "@/api/env-base";
import { queryCountLogger } from "@/api/lib/db-query-counter";
import { runTransactionsInCallerContext } from "@/api/lib/db/caller-async-context";
import type { RegistrationQuery } from "@/api/lib/db/operator-registrations/input";
import { readAuditedRegistrationPage } from "@/api/lib/db/operator-registrations/read";
import { createSanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import { isLocalDevOpen } from "@/api/runtime-mode";

// Per-request query counter feeds the `x-db-queries` response header for the
// N+1 e2e guard. Local/CI only: deployed environments pass no logger at all,
// keeping zero per-query overhead on the hot path. The logger itself is a
// no-op unless a request has activated a counter store, so background jobs
// and boot-time queries are unaffected even when it is wired in. Must match
// the header gate in index.ts.
const queryLogger = isLocalDevOpen() ? queryCountLogger : undefined;

// Optional pool recycling. Defaults remain disabled until the Bun SQL runtime
// retires only idle connections; values are seconds and apply to both pools.
const poolRecycling = {
  maxLifetime: envBase.DATABASE_POOL_MAX_LIFETIME_S,
  idleTimeout: envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
} as const;

// A transaction runs in the async context of the request that opened it, so
// its statements count toward that request's query budget, not a neighbour's.
const rootClient = runTransactionsInCallerContext(
  new SQL({
    url: envBase.DATABASE_URL,
    max: envBase.DATABASE_ROOT_POOL_MAX,
    ...poolRecycling,
    ...sharedPoolConnectionSettings("root"),
  }),
);
const rlsClient = runTransactionsInCallerContext(
  new SQL({
    url: envBase.DATABASE_URL,
    max: envBase.DATABASE_RLS_POOL_MAX,
    ...poolRecycling,
    ...sharedPoolConnectionSettings("raw_rls"),
  }),
);

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

/** The connection owner supplies only a role-restricted sanctions reader. */
export const createPublicSanctionsReader = () =>
  createSanctionsPublicReadDb(rlsDb);

/** The operator handler receives a bounded audited page, never the owner handle. */
export const readOperatorRegistrationPage = async (query: RegistrationQuery) =>
  await readAuditedRegistrationPage(rootDb, query);

type Database = typeof rootDb;
export type Transaction = TransactionOf<Database>;
