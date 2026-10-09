/**
 * Drop and recreate a disposable local database so the next seed starts from
 * nothing. The roles the migrations create are dropped with it: a role belongs
 * to the server rather than the database, so it would otherwise outlive the
 * database and fail the next migration run that creates it. `bun run agent:reset` runs it against a worktree's own stack, then
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
import path from "node:path";

import { resolveDatabaseUrl } from "@/api/db-url";
import { requireLocalDevOpen } from "@/api/runtime-mode";

import { migrationCreatedRoles } from "./migration-roles";

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
await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
// Only roles a migration creates; the login the stack connects with exists
// before any migration and stays. With their database gone, these roles hold
// nothing there; a dependency left in another local database fails here,
// before the database is recreated, rather than in the next migration run.
const roles = migrationCreatedRoles(
  path.resolve(import.meta.dir, "../drizzle"),
);
for (const role of roles) {
  await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
}
await admin.unsafe(`CREATE DATABASE "${database}"`);
await admin.close();
console.log(`Recreated local database ${database}`);
