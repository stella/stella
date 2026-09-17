/**
 * Online repair for the Better Auth OAuth resource policy.
 *
 * Every MCP audience is an OAuth resource, and startup refuses to serve until
 * `oauth_resource` matches `buildBetterAuthOAuthResources()` exactly and every
 * client registration is linked to a configured resource
 * (`ensureBetterAuthOAuthPolicy`). Startup deliberately does not repair:
 * `resourceSeedMode: "none"` in `lib/auth.ts` keeps resource creation out of
 * the request path, and `initializePristineBetterAuthOAuthPolicy` seeds only an
 * entirely empty auth database.
 *
 * That left adding an audience with no automated path onto an existing
 * database. The one-time 1.7 cutover command owns the same work, but it is an
 * operator script: it wants a write freeze and the private trusted-identity
 * manifest, and no deploy path runs it. Shipping an audience against that would
 * mean the next release's API failing its boot census on every environment
 * until somebody ran a script by hand.
 *
 * So the policy half of that backfill runs here instead, on the migrate
 * entrypoint, before the API rolls. It reuses the cutover command's own
 * functions (`seedOAuthResources`, `backfillOAuthClients`) rather than
 * reimplementing their semantics, which is what keeps a resource seeded by a
 * deploy identical to one seeded by the cutover: a missing resource is
 * inserted, a matching one is left alone, and a conflicting definition refuses
 * the whole thing instead of overwriting it. The identity half of the cutover
 * (`backfillAccounts`) stays private to that command; it needs the manifest and
 * the freeze, and nothing about adding an audience touches identities.
 *
 * Importing a `scripts/*.logic.ts` module from a repair is the existing shape
 * here: `decision-date-ceiling-repair.ts` drives `repair-decision-dates-plan.ts`
 * the same way, so one plan serves both the operator command and the deploy.
 *
 * Idempotent and self-checkpointing without bookkeeping: both functions decide
 * per row from the database's current state, so an interrupted run resumes by
 * running again and a completed run inserts and links nothing. `assertComplete`
 * is the same census the API runs at startup, so a partial repair fails the
 * deploy rather than the boot.
 *
 * Nothing here reads the API's environment. The migrate entrypoint runs with a
 * database-only environment (the ECS `api-migrate` task definition injects
 * `HOME`, `NODE_ENV` and the `DB_*` components, and nothing else), so reaching
 * the env-backed `getBetterAuthOAuthResources()` made `bun run
 * src/db/migrate.ts` die on `S3_BUCKET` before it opened a connection. The
 * origin the resource identifiers are built on therefore comes from the rows
 * already in `oauth_resource`, which carry this deployment's own absolute
 * identifiers and are written only by Stella's own seeding paths. That is exact
 * per environment with nothing to configure, and it fails closed: an empty
 * table is a fresh database, which startup's pristine seeding owns, and more
 * than one origin is an ambiguous policy a deploy must not guess at.
 */

import { panic, Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { assertBetterAuthOAuthPolicyCensus } from "../lib/db/better-auth-oauth-policy-census";
import { isRecord } from "../lib/type-guards";
import { buildBetterAuthOAuthResources } from "../mcp/resource-policy-contract";
import {
  backfillOAuthClients,
  seedOAuthResources,
} from "../scripts/better-auth-17-backfill.logic";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";

const REPAIR_NAME = "better-auth-oauth-resources";

/**
 * Client registrations per page. The linking statement is an upsert keyed by
 * (client, resource) and every page runs inside the one repair transaction, so
 * this bounds the statement's parameter list rather than the lock duration.
 */
const CLIENT_PAGE_SIZE = 200;

/**
 * Budgets LOCAL to the repair's transaction. `oauth_resource` and
 * `oauth_client_resource` are configuration-sized tables, so this is sized for
 * a short write, not for a scan; a run that hits the lock timeout is contended
 * with another deploy holding the online-migrations lock, and the migrate
 * task's retry starts it over from a state it can read.
 */
const LOCK_TIMEOUT = "10s";
const STATEMENT_TIMEOUT = "2min";

const READ_RESOURCE_IDENTIFIERS_SQL = "SELECT identifier FROM oauth_resource";

const dialect = new PgDialect();

/**
 * The connection as the backfill functions and the census see it: a drizzle
 * fragment rendered to a parameterised query on the reserved connection, so the
 * whole repair shares the session holding the online-migrations lock.
 */
const bindTo = (connection: OnlineMigrationConnection) => ({
  execute: async (query: SQL): Promise<unknown> => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    return await connection.query(text, params);
  },
});

/**
 * The origin this deployment's resource identifiers are built on, read off the
 * identifiers it already stores. `null` when the table is empty: a fresh
 * database has no policy to reconcile and startup's pristine seeding owns it.
 */
const readStoredOrigin = async (
  connection: OnlineMigrationConnection,
): Promise<string | null> => {
  const rows = await connection.query(READ_RESOURCE_IDENTIFIERS_SQL);
  const origins = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row["identifier"] !== "string") {
      return panic(
        `Online repair ${REPAIR_NAME}: oauth_resource has an invalid shape`,
      );
    }
    const parsed = URL.parse(row["identifier"]);
    if (parsed === null) {
      return panic(
        `Online repair ${REPAIR_NAME}: a stored resource identifier is not a URL`,
      );
    }
    origins.add(parsed.origin);
  }
  if (origins.size > 1) {
    // Two origins mean two deployments' policies in one database. Guessing
    // which one a new audience belongs to could advertise it on the wrong
    // host, so the deploy stops instead.
    return panic(
      `Online repair ${REPAIR_NAME}: oauth_resource holds ${String(origins.size)} distinct origins`,
    );
  }
  const [origin] = [...origins];
  return origin === undefined ? null : origin;
};

const repair = async (connection: OnlineMigrationConnection): Promise<void> => {
  const origin = await readStoredOrigin(connection);
  if (origin === null) {
    return;
  }
  const expectedResources = buildBetterAuthOAuthResources(origin);

  await connection.execute("BEGIN");
  // Transaction boundary on a raw connection: a failure is rolled back so the
  // session stays usable for the lock release, then rethrown to fail the
  // migrate task. Seeding and linking share one transaction because a resource
  // that exists while no client is linked to it fails the census, and the
  // deploy should not be able to stop between the two.
  try {
    await connection.execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await connection.execute(
      `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`,
    );
    const transaction = bindTo(connection);

    const seeded = await seedOAuthResources(transaction, expectedResources);
    if (Result.isError(seeded)) {
      throw seeded.error;
    }

    const linked = await backfillOAuthClients(
      transaction,
      CLIENT_PAGE_SIZE,
      expectedResources,
    );
    if (Result.isError(linked)) {
      throw linked.error;
    }

    await connection.execute("COMMIT");
  } catch (error: unknown) {
    await connection.execute("ROLLBACK");
    throw error;
  }
};

const assertComplete = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  const origin = await readStoredOrigin(connection);
  if (origin === null) {
    // Nothing was owed, so nothing is incomplete. The API's own startup gate
    // seeds and then verifies a fresh database.
    return;
  }
  const census = await Result.tryPromise({
    try: async () =>
      await assertBetterAuthOAuthPolicyCensus(
        bindTo(connection),
        buildBetterAuthOAuthResources(origin),
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(census)) {
    // The same check the API runs before it serves. Failing here means the
    // deploy stops with the repair named, instead of every API task
    // crash-looping on its boot gate.
    panic(
      `Online repair ${REPAIR_NAME} is not complete: the Better Auth OAuth policy census failed`,
      census.error,
    );
  }
};

export const BETTER_AUTH_OAUTH_RESOURCE_REPAIR: OnlineRepair = {
  assertComplete,
  name: REPAIR_NAME,
  repair,
};
