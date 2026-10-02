import { panic } from "better-result";
import { SQL } from "bun";
import nodePath from "node:path";

// Relative imports: this entrypoint also ships as a loose file without tsconfig.
import { resolveDatabaseUrl } from "../db-url";
import { envDbLoadGate } from "../env-db-load-gate";
import {
  requireEbsConfiguration,
  resolveEbsConfiguration,
} from "../lib/db/ebs-signal-reader";
import { runMigrationsUntilSettled } from "./migration-runner";

// An index build would hold forever on a load gate nobody configured, and the
// deploy waits on this process: reject that before any connection opens.
const ebs = requireEbsConfiguration(resolveEbsConfiguration(envDbLoadGate));
if (ebs.isErr()) {
  // oxlint-disable-next-line no-console -- migrate CLI entrypoint; surface the failure to the deploy log
  console.error("[migrate] failed:", ebs.error);
  process.exit(1);
}

const url = resolveDatabaseUrl();
if (!url) {
  panic(
    "migrate: no database connection; set DATABASE_URL or the DB_* components",
  );
}

const client = new SQL({ url, max: 1 });
// The loose source and single-file bundle both resolve drizzle from this file.
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");
const connection = await client.reserve();
try {
  const result = await runMigrationsUntilSettled({
    connection,
    databaseUrl: url,
    migrationsFolder,
    ebs: ebs.value,
  });
  if (result.status === "applied") {
    // oxlint-disable-next-line no-console -- migrate CLI entrypoint; stdout is its interface
    console.info("[migrate] migrations applied");
  }
} catch (error) {
  // oxlint-disable-next-line no-console -- migrate CLI entrypoint; surface the failure to the deploy log
  console.error("[migrate] failed:", error);
  process.exitCode = 1;
} finally {
  connection.release();
  await client.end();
}
