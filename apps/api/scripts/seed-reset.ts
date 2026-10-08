/**
 * Drop and recreate a disposable local database so the next seed starts from
 * nothing. `bun run agent:reset` runs it against a worktree's own stack, then
 * restarts the stack, which migrates, seeds and seals it again.
 *
 * Refuses anything but a local server, and runs only with local development
 * access open.
 *
 * Usage:
 *   bun scripts/seed-reset.ts --confirm-local-reset
 */

import { panic } from "better-result";
import { SQL } from "bun";

import { runScriptWithErrorOutput } from "@stll/errors";

import { resolveDatabaseUrl } from "@/api/db-url";
import { requireLocalDevOpen } from "@/api/runtime-mode";

const CONFIRM_FLAG = "--confirm-local-reset";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// The server's always-present database, used as the connection target so the
// seeded database itself can be dropped.
const ADMIN_DATABASE = "postgres";

if (!process.argv.includes(CONFIRM_FLAG)) {
  panic(`Refusing to reset without ${CONFIRM_FLAG}`);
}
requireLocalDevOpen("Resetting the database");

const url = new URL(
  resolveDatabaseUrl() ?? panic("No database connection is configured"),
);
if (!LOCAL_HOSTS.has(url.hostname)) {
  panic(`Refusing to reset a database on ${url.hostname}; local only`);
}
const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
// Interpolated into DDL below, so only a plain identifier passes.
if (!/^[a-z_][a-z0-9_]*$/u.test(database) || database === ADMIN_DATABASE) {
  panic(`Refusing to reset database "${database}"`);
}

url.pathname = `/${ADMIN_DATABASE}`;
const admin = new SQL({ max: 1, url: url.toString() });
await runScriptWithErrorOutput(async () => {
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    console.log(`Recreated local database ${database}`);
  } finally {
    await admin.close();
  }
});
