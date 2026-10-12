import { panic } from "better-result";

import { openBoundedDatabaseObserver } from "../src/db/online-index-observer";

// Allow conflicting maintenance to finish beyond autovacuum's cancellation grace.
export const POSTGRES_TEST_MAINTENANCE_TIMEOUTS = {
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 5000,
};

// Disable automatic maintenance only on this migrated fixture's tables. Tests
// of real autovacuum create fresh databases whose defaults remain enabled.
export const POSTGRES_TEST_MAINTENANCE_SQL = `
DO $$
DECLARE target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.oid
  LOOP
    EXECUTE format('ALTER TABLE %s SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)', target);
  END LOOP;
END $$`;

if (import.meta.main) {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? panic("Missing DATABASE_URL");
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/stella") {
    panic("Postgres test maintenance requires the ephemeral CI database");
  }
  const client = await openBoundedDatabaseObserver({
    url: databaseUrl,
    ...POSTGRES_TEST_MAINTENANCE_TIMEOUTS,
  });
  try {
    await client.execute(POSTGRES_TEST_MAINTENANCE_SQL);
    console.log(
      "Postgres fixture table autovacuum disabled; fresh database defaults retained.",
    );
    console.log(
      JSON.stringify(
        await client.query(`SELECT name, setting, unit, source FROM pg_settings
          WHERE name IN ('autovacuum', 'deadlock_timeout', 'lock_timeout') ORDER BY name`),
      ),
    );
  } finally {
    await client.release();
  }
}
